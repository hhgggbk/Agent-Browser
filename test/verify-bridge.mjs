// End-to-end proof for the identity bridge: a real Chrome, an unpacked MV3
// extension, and cookies that Chrome itself decrypted.
//
// Runs entirely against a throwaway profile on a non-default data dir, so the
// debugging port is allowed here and the user's real browser is never opened.
// What this proves is the MECHANICS (extension reads plaintext, domain filter,
// write-back, auth). What it cannot prove is that his own Chrome loads the
// extension — that is one click in chrome://extensions, and it is stated as
// unverified rather than assumed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { IdentityBridge, createIdentityBridge } from "../src/bridge.js";
import { AgentBrowser } from "../src/agent-browser.js";
import { readLocalStorage } from "../src/localstorage-reader.js";

const CHROME = process.env.CHROME_EXE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT_DIR = path.join(process.cwd(), "cookie-extension");
const BRIDGE_PORT = Number(process.env.VERIFY_BRIDGE_PORT || 8791);
const CDP_PORT = 9877;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
}
function getJson(url, t = 1500) {
  return new Promise((res) => {
    const r = http.get(url, { timeout: t }, (x) => {
      let b = "";
      x.on("data", (c) => (b += c));
      x.on("end", () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on("timeout", () => { r.destroy(); res(null); });
    r.on("error", () => res(null));
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-bridge-"));
const bridge = new IdentityBridge({ port: BRIDGE_PORT, extensionDir: EXT_DIR });
await bridge.start();

const child = spawn(CHROME, [
  `--user-data-dir=${path.join(dir, "profile")}`,
  `--remote-debugging-port=${CDP_PORT}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--no-sandbox", "--password-store=basic", "--use-mock-keychain",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

// Chrome 155 ignores --load-extension on stable: the extension ends up in
// Secure Preferences with a valid path but its worker never starts. The
// supported install is CDP Extensions.loadUnpacked, and passing the old flags
// alongside it actively breaks the load.
async function loadUnpacked(browser) {
  if (typeof browser.newBrowserCDPSession === "function") {
    try {
      const s = await browser.newBrowserCDPSession();
      const r = await s.send("Extensions.loadUnpacked", { path: EXT_DIR });
      return r?.id || r?.extensionId || null;
    } catch {}
  }
  const ver = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 3000);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const reply = await new Promise((r) => {
    const p = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
    p.set(1, r);
    ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: EXT_DIR } }));
  });
  ws.close();
  return reply.result?.id || null;
}
let stderr = "";
child.stderr.on("data", (c) => (stderr += c.toString()));

let browser = null;
let siteServer = null;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    }
  }
  if (!browser) throw new Error("chrome did not open a debug port: " + stderr.slice(0, 300));
  const ctx = browser.contexts()[0];

  const extId = await loadUnpacked(browser);
  check("extension installs over CDP", Boolean(extId), `id=${extId}`);

  // Seed through CDP so the values are known, then read them back through the
  // extension. Two origins: an IP host and a named domain, plus a bystander
  // domain that must NOT come back when we ask for the first two.
  const now = Math.floor(Date.now() / 1000);
  await ctx.addCookies([
    { name: "ab_local", value: "LOCAL_4471", domain: "127.0.0.1", path: "/" },
    { name: "ab_sess", value: "SESS_8890", domain: ".example.test", path: "/", expires: now + 86400 },
    { name: "ab_secure", value: "SEC_1122", domain: ".example.test", path: "/", expires: now + 86400, secure: true, sameSite: "None" },
    { name: "ab_other", value: "NOPE_0001", domain: ".bystander.test", path: "/", expires: now + 86400 },
  ]);

  // Seed localStorage through a real page so the profile's leveldb picks it up;
  // the disk reader must find it after the browser shuts down.
  const site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>bridge-fixture</body></html>");
  });
  siteServer = site;
  await new Promise((r) => site.listen(9779, "127.0.0.1", r));
  const seedPage = await ctx.newPage();
  await seedPage.goto("http://127.0.0.1:9779/", { waitUntil: "domcontentloaded" });
  await seedPage.evaluate(() => localStorage.setItem("ab_ls_device", "DEV_7311"));
  await seedPage.close();

  // The extension must announce itself before the bridge will answer.
  let waited = 0;
  while (!bridge.connected && waited < 20000) {
    await new Promise((r) => setTimeout(r, 500));
    waited += 500;
  }
  check("extension registers with the bridge", bridge.connected,
    `after ${waited}ms  status=${JSON.stringify(bridge.status())}`);
  if (!bridge.connected) {
    const targets = (await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 3000)) || [];
    check("bridge round trip completed", false,
      "extension never connected; targets=" +
        targets.map((t) => `${t.type}:${String(t.url).slice(0, 60)}`).join(" | ").slice(0, 400));
    throw new Error("stop");
  }

  const got = await bridge.cookies(["127.0.0.1", "example.test"]);
  const names = got.map((c) => c.name).sort();
  check("bridge returns the cookies Chrome decrypted",
    names.includes("ab_local") && names.includes("ab_sess") && names.includes("ab_secure"),
    `names=${names.join(",")}`);
  check("values are plaintext, not __encrypted__ or v20",
    got.every((c) => typeof c.value === "string" && !c.value.startsWith("__encrypted__")),
    got.map((c) => `${c.name}=${c.value}`).join(" "));
  check("unrequested domain is not returned", !names.includes("ab_other"), `names=${names.join(",")}`);
  const secure = got.find((c) => c.name === "ab_secure");
  check("secure + SameSite=None survive the round trip",
    secure?.secure === true && secure?.sameSite === "None",
    secure ? `secure=${secure.secure} sameSite=${secure.sameSite}` : "missing");
  check("expiry is reported, session cookies are marked",
    got.find((c) => c.name === "ab_sess")?.expires > now && got.find((c) => c.name === "ab_local")?.session === true,
    `sess.expires=${got.find((c) => c.name === "ab_sess")?.expires} local.session=${got.find((c) => c.name === "ab_local")?.session}`);

  // Disk reader: the same profile's localStorage, read while the browser runs.
  // Chrome commits lazily, so poll briefly before giving up.
  let lsEntry = null;
  let lsDiag = null;
  for (let i = 0; i < 20 && !lsEntry; i++) {
    const ls = await readLocalStorage({ profileRoot: path.join(dir, "profile"), origins: ["http://127.0.0.1:9779"] });
    const e = ls.byOrigin["http://127.0.0.1:9779"];
    if (e?.ab_ls_device === "DEV_7311") lsEntry = e;
    else {
      const lsr = await readLocalStorage({ profileRoot: path.join(dir, "profile"), origins: ["http://127.0.0.1:9779"], raw: true });
      lsDiag = { origins: lsr.origins, seen: lsr.byOrigin["http://127.0.0.1:9779"] || null };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("localStorage read back from the profile on disk", Boolean(lsEntry),
    lsEntry ? `keys=${Object.keys(lsEntry).length}` : `never appeared: ${JSON.stringify(lsDiag)}`);

  // The handoff the synthetic suite was missing: bridge cookies into the agent
  // browser. The real-browser run caught addCookies rejecting expires:null.
  const agent = new AgentBrowser({ scope: "bridge-handoff", headless: true });
  try {
    await agent.start();
    const n = await agent.restoreCookies(got);
    const jar2 = await agent.currentCookies();
    check("bridge cookies restore into the agent browser",
      n === got.length && jar2.some((c) => c.name === "ab_sess" && c.value === "SESS_8890"),
      `restored=${n} of ${got.length} jar=${jar2.map((c) => c.name).sort().join(",")}`);
    check("session cookie survives as a session cookie",
      jar2.some((c) => c.name === "ab_local" && (!c.expires || c.expires === -1)),
      `ab_local.expires=${jar2.find((c) => c.name === "ab_local")?.expires}`);
    if (lsEntry) {
      await agent.restoreStorage("http://127.0.0.1:9779", { localStorage: lsEntry, sessionStorage: {} });
      const lp = await agent.page("http://127.0.0.1:9779/");
      const v = await lp.evaluate(() => localStorage.getItem("ab_ls_device"));
      check("localStorage survives into the agent browser", v === "DEV_7311", `value=${v}`);
      await lp.close().catch(() => {});
    }
  } finally {
    await agent.close().catch(() => {});
  }

  // Write-back direction: the bridge sets a cookie, CDP reads the same jar.
  const setRes = await bridge.setCookies([
    { name: "ab_written", value: "WRIT_3344", domain: ".example.test", path: "/", secure: true, sameSite: "None", expires: now + 3600 },
  ]);
  check("write-back reports success", setRes.applied.includes("ab_written"),
    `applied=${setRes.applied.join(",")} failed=${JSON.stringify(setRes.failed)}`);
  const jar = await ctx.cookies();
  const written = jar.find((c) => c.name === "ab_written");
  check("cookie written through the extension is visible to the browser",
    written?.value === "WRIT_3344", `value=${written?.value}`);

  // Client mode: the MCP server and a task run are separate processes, and the
  // second one must join the bridge instead of failing to bind it.
  const second = await createIdentityBridge({ port: BRIDGE_PORT, extensionDir: EXT_DIR });
  check("a second handle joins as a client, not a host", second.hosting === false,
    `hosting=${second.hosting} class=${second.constructor.name}`);
  const viaClient = await second.cookies(["example.test"]);
  check("client reads through the hosted bridge", viaClient.some((c) => c.name === "ab_sess"),
    `names=${viaClient.map((c) => c.name).join(",")}`);

  // Auth: an unkeyed poll must not be served, and /status stays readable.
  const unkeyed = await new Promise((res) => {
    http.get({ host: "127.0.0.1", port: BRIDGE_PORT, path: "/extension/poll", timeout: 3000 }, (x) => {
      let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res({ code: x.statusCode, b }));
    }).on("error", () => res({ code: 0, b: "" }));
  });
  check("poll without the key is rejected", unkeyed.code === 401, `code=${unkeyed.code}`);
  const status = await getJson(`http://127.0.0.1:${BRIDGE_PORT}/status`);
  check("status reports the connected extension", status?.connected === true && status?.extensionId,
    JSON.stringify(status).slice(0, 120));
} catch (e) {
  if (!/stop/.test(String(e.message || e))) {
    check("bridge round trip completed", false, String(e.message || e).slice(0, 300));
  }
  if (/load-extension|never connected/.test(String(e.message || e))) {
    console.log("stderr: " + stderr.split(/\r?\n/).filter(Boolean).slice(0, 5).join(" | "));
  }
} finally {
  await bridge.stop().catch(() => {});
  await new Promise((r) => siteServer?.close(r));
  try {
    if (browser) {
      const ctx = browser.contexts()[0];
      const p = ctx.pages()[0] || (await ctx.newPage());
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Browser.close", {}).catch(() => {});
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 2500));
  try { child.kill("SIGKILL"); } catch {}
  await browser?.close().catch(() => {});
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  try { fs.rmSync(path.join(EXT_DIR, "bridge-config.json"), { force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
