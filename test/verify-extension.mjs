// Loads real unpacked extensions into the agent browser over CDP and proves
// they actually run there.
//
// Target under test: the user's own VideoDownloader extension
// (override with VD_EXT_PATH). Nothing here touches his daily Chrome — the
// extensions land in a throwaway profile that is deleted at the end.
//
// The drive path matters: a tab cannot navigate to chrome-extension://<id>/popup.html
// unless the manifest declares web_accessible_resources (Chrome answers
// ERR_BLOCKED_BY_CLIENT), so extension logic is reached through its service
// worker session and through its content-script world — both measured here.
import { AgentBrowser } from "../src/agent-browser.js";
import { IdentityBridge } from "../src/bridge.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Any unpacked extension works as the load target; defaulting to the author's
// own folder would only ever pass on his machine, so it is opt-in.
const VD = process.env.VD_EXT_PATH || "";
if (!VD || !fs.existsSync(VD)) {
  console.log("跳过 verify-extension：设 VD_EXT_PATH=<未打包扩展目录（含 manifest.json）> 再跑这套");
  process.exit(0);
}
const SITE_PORT = 9813;
const origin = `http://127.0.0.1:${SITE_PORT}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? ` — ${detail}` : ""));
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><body><h1 id="t">FIXTURE</h1><video src="${origin}/clip.mp4" controls></video></body></html>`);
});
await new Promise((r) => server.listen(SITE_PORT, "127.0.0.1", r));

// cookie-extension gets copied so the repo's live bridge-config is undisturbed
const extCopy = fs.mkdtempSync(path.join(os.tmpdir(), "ab-extcopy-"));
for (const f of ["manifest.json", "background.js", "probe.html", "probe.js"]) {
  fs.copyFileSync(path.join(process.cwd(), "cookie-extension", f), path.join(extCopy, f));
}
const bridge = new IdentityBridge({ port: 8902, extensionDir: extCopy });
await bridge.start();

// A woken MV3 worker, found through Playwright's own API. Raw CDP attach does
// not work here: in flatten mode sessionId belongs to the message envelope, and
// Playwright's send(method, params) cannot set it, so the call would land on the
// browser target where Runtime does not exist.
async function waitForWorker(context, id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const w = context.serviceWorkers().find((x) => String(x.url()).startsWith(`chrome-extension://${id}/`));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const agent = new AgentBrowser({ headless: true, extensions: [VD, extCopy] });
await agent.start();
let browserCdp = null;

try {
  const vd = agent.extensions.find((e) => e.path === VD);
  const cookie = agent.extensions.find((e) => e.path === extCopy);
  check("two unpacked extensions load into the agent browser",
    agent.extensions.every((e) => /^[a-p]{32}$/.test(e.id || "")),
    agent.extensions.map((e) => `${path.basename(e.path)}=${e.id}`).join("  "));

  const proc = agent.context.browser?.()?.process?.();
  const cmdline = [(proc?.spawnfile || ""), ...(proc?.spawnargs || [])].join(" ");
  check("no --load-extension in the launch command", !cmdline.includes("load-extension"),
    cmdline ? "clean" : "(no process handle)");

  browserCdp = await agent.context.browser().newBrowserCDPSession();
  const dump = async (label) => {
    const { targetInfos } = await browserCdp.send("Target.getTargets");
    return targetInfos.map((t) => `${t.type}:${String(t.url).slice(0, 40)}`).join(" | ") || `(empty ${label})`;
  };
  const before = await dump("right after load");
  check("an idle MV3 worker is not listed right after install (why events matter)",
    !before.includes(vd.id), before.slice(0, 200));

  // Wake the worker the way the extension does in use: its content script,
  // running in a real page, sends the background a message.
  const page = await agent.page(origin);
  const pcdp = await agent.context.newCDPSession(page);
  const contexts = [];
  pcdp.on("Runtime.executionContextCreated", (e) => contexts.push(e.context));
  await pcdp.send("Runtime.enable");
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1500));
  // Injection check from the events collected during the reload.
  const injected = contexts.filter((c) => c.origin === `chrome-extension://${vd.id}`);
  check("myContent.js is injected as its own world in a normal page",
    injected.length > 0, `origins=${JSON.stringify(contexts.map((c) => c.origin))}`.slice(0, 200));

  // Context ids do not survive navigations: the id captured at event time can be
  // gone by the time we evaluate (measured: every run failed with "Cannot find
  // context with specified id"). Ask for a fresh one right before the call.
  contexts.length = 0;
  await page.reload({ waitUntil: "domcontentloaded" });
  for (let i = 0; i < 20 && !contexts.some((c) => c.origin === `chrome-extension://${vd.id}`); i++) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const csWorld = contexts.filter((c) => c.origin === `chrome-extension://${vd.id}`).pop() || null;

  const roundTrip = csWorld
    ? await pcdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const r = await chrome.runtime.sendMessage({ eventName: 'get-media' });
          return JSON.stringify(r);
        })()`,
        awaitPromise: true, returnByValue: true, contextId: csWorld.id,
      }).then((r) => r.result?.value).catch((e) => `ERR ${e.message}`)
    : "(no world)";
  check("content script <-> service worker messaging works in the agent browser",
    roundTrip && roundTrip.includes("items"), String(roundTrip).slice(0, 120));

  // The message above woke it: now Playwright lists the worker.
  const vdWorker = await waitForWorker(agent.context, vd.id);
  check("the woken MV3 worker shows up under its own id",
    Boolean(vdWorker), `workers=${agent.context.serviceWorkers().map((w) => w.url().slice(0, 46)).join(" | ") || "(none)"}`);

  const name = vdWorker ? await vdWorker.evaluate(() => chrome.runtime.getManifest().name) : null;
  check("API works inside the extension origin", name === "VideoDownloader", `name=${name}`);

  const popupServed = vdWorker
    ? await vdWorker.evaluate(async () => {
        const r = await fetch(chrome.runtime.getURL("popup.html"));
        const t = await r.text();
        return JSON.stringify({ ok: r.ok, hasBtn: t.includes("btn-extract"), len: t.length });
      })
    : null;
  check("the extension's own files are readable from its worker",
    /"ok":true.*"hasBtn":true/.test(String(popupServed)), String(popupServed));

  const perms = vdWorker
    ? await vdWorker.evaluate(() => JSON.stringify(chrome.runtime.getManifest().permissions))
    : null;
  check("the worker reports its permissions", /webRequest/.test(String(perms)), String(perms));

  // Extension pages open as ordinary tabs. The ERR_BLOCKED_BY_CLIENT seen while
  // --disable-extensions was still in the command line was not a
  // web_accessible_resources rule — it was the extension not existing at all,
  // so this check doubles as a live-extension assertion.
  const extPage = await agent.page(`chrome-extension://${vd.id}/popup.html`);
  const uiText = await extPage.textContent("#btn-extract").catch(() => null);
  check("the extension's popup opens as a page and renders its UI", Boolean(uiText),
    `#btn-extract=${JSON.stringify(uiText)}`);
  await extPage.close().catch(() => {});

  // the cookie extension, running inside the agent browser, talks to the bridge
  const t0 = Date.now();
  while (!bridge.status().connected && Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  check("cookie-extension inside the agent browser registers with the bridge",
    bridge.status().connected, `id=${bridge.status().extensionId} after ${Date.now() - t0}ms`);
  const cookieWorker = await waitForWorker(agent.context, cookie.id);
  const cookiesNow = cookieWorker
    ? await cookieWorker.evaluate(async () => JSON.stringify((await chrome.cookies.getAll({})).map((c) => c.name)))
    : null;
  check("and its chrome.cookies works there", Boolean(cookiesNow) && Array.isArray(JSON.parse(cookiesNow)),
    `jar=${String(cookiesNow).slice(0, 80)}`);

  let blocked = null;
  try { await agent.page(`${origin}/settings/tokens`); } catch (e) { blocked = e.name; }
  check("guard still blocks a禁区 URL with extensions loaded", blocked === "GuardViolation", `got=${blocked}`);

  const bad = path.join(os.tmpdir(), "ab-no-ext");
  fs.mkdirSync(bad, { recursive: true });
  let err = null;
  try { await agent.loadExtension(bad); } catch (e) { err = e.message; }
  check("a directory with no manifest.json fails loudly", /no manifest.json/.test(err || ""), (err || "").slice(0, 60));
  fs.rmSync(bad, { recursive: true, force: true });

  // an MV3 manifest Chrome itself rejects must surface Chrome's reason
  const hostile = fs.mkdtempSync(path.join(os.tmpdir(), "ab-bad-ext-"));
  fs.writeFileSync(path.join(hostile, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "", version: "x" }));
  let herr = null;
  try { await agent.loadExtension(hostile); } catch (e) { herr = e.message; }
  check("Chrome's own refusal is passed through verbatim",
    /loadUnpacked/.test(herr || "") && /name|version/i.test(herr || ""), (herr || "").slice(0, 120));
  fs.rmSync(hostile, { recursive: true, force: true });
} finally {
  await agent.close().catch(() => {});
  await bridge.stop().catch(() => {});
  server.close();
  fs.rmSync(extCopy, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
