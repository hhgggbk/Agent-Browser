// Can a hand-loaded (unpacked) MV3 extension pick up edited files?
// Background: on Chrome 155 a single chrome.runtime.reload() is final — the
// worker never calls in again — so "just add a reload button" is not an option.
// This probe answers the two safe routes, judged on function only:
//
//   reload   runtime.reload() once                      -> expected dead (plain arm)
//   rescue   same, with --disable-features=…            -> expected alive
//   version  loadUnpacked again on the same path after  -> new code answers
//            editing background.js
//   swap     uninstall, then loadUnpacked the same path -> same id, new code
//
// Every arm is throwaway: temp profile, temp extension copy, no user profile.
//   node test/probe-reload-trap.mjs
import { AgentBrowser } from "../src/agent-browser.js";
import { IdentityBridge } from "../src/bridge.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.join(process.cwd(), "cookie-extension");
const APIS = ["manifest.json", "background.js", "probe.html", "probe.js"];
const MARKER = 'if (request.type === "ping") {';

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? ` — ${detail}` : ""));
};

function copyExt(dir, markNew) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of APIS) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  if (markNew) upgrade(dbFile(dir));
}

const dbFile = (dir) => path.join(dir, "background.js");

function upgrade(file) {
  const body = fs.readFileSync(file, "utf8");
  if (body.includes("abProbeVersion")) return;
  fs.writeFileSync(
    file,
    body.replace(MARKER, 'if (request.type === "abProbeVersion") { return { ok: true, data: { v: 2 } }; }\n  ' + MARKER),
  );
}

async function waitHello(bridge, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (bridge.connected) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// "Connected" is not enough: the worker we want is the one that knows the op.
async function waitVersion(bridge, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await bridge.request({ type: "abProbeVersion" }, { timeoutMs: 4000 }).catch(() => null);
    if (r && r.v === 2) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function arm(label, port, extraArgs) {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-reload-ext-"));
  copyExt(extDir, false);
  const bridge = new IdentityBridge({ port, extensionDir: extDir });
  await bridge.start();
  const agent = new AgentBrowser({ headless: true, extensions: [extDir], extraArgs, launchTimeout: 45000 });
  try {
    await agent.start();
    check(`[${label}] v1 worker reports hello`, (await waitHello(bridge, 20000)) !== null);

    const sw = agent.context.serviceWorkers()[0];
    if (!sw) {
      check(`[${label}] service worker reachable`, false);
      return;
    }
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
    bridge.hello = null;
    await new Promise((r) => setTimeout(r, 2000));
    const back = await waitHello(bridge, 45000);
    check(`[${label}] worker survives one reload()`, back !== null, `ms=${back}`);
    if (back !== null) {
      const p = await bridge.ping().catch((e) => ({ err: String(e.message).slice(0, 60) }));
      check(`[${label}] functional after reload`, Boolean(p && p.alive), JSON.stringify(p).slice(0, 80));
    }
  } finally {
    await agent.close().catch(() => {});
    await bridge.stop().catch(() => {});
    fs.rmSync(extDir, { recursive: true, force: true });
  }
}

async function versionArms() {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-version-ext-"));
  copyExt(extDir, false);
  const bridge = new IdentityBridge({ port: 8922, extensionDir: extDir });
  await bridge.start();
  const agent = new AgentBrowser({ headless: true, extensions: [extDir], launchTimeout: 45000 });
  try {
    const id1 = await agent.start().then(() => agent.extensions[0].id);
    check("[version] v1 up", (await waitHello(bridge, 20000)) !== null, `id=${id1}`);

    // Route A: edit the files, then loadUnpacked the same path again.
    upgrade(dbFile(extDir));
    const idA = await agent.loadExtension(extDir).catch((e) => `ERR ${e.message.slice(0, 60)}`);
    const tA = await waitVersion(bridge, 25000);
    check("[version] same-path loadUnpacked picks up edited code", tA !== null, `id=${idA} ms=${tA}`);

    // Route B: uninstall, then load the same path. Id should be stable.
    const sess = await agent.context.browser().newBrowserCDPSession();
    const un = await sess.send("Extensions.uninstall", { id: id1 }).catch((e) => ({ error: e.message.slice(0, 80) }));
    bridge.hello = null;
    await new Promise((r) => setTimeout(r, 1500));
    const idB = await agent.loadExtension(extDir).catch((e) => `ERR ${e.message.slice(0, 60)}`);
    const backB = await waitHello(bridge, 20000);
    check("[version] uninstall then load again comes back", backB !== null, `id=${idB} sameId=${idB === id1} uninstall=${JSON.stringify(un).slice(0, 40)}`);
    const pB = await bridge.request({ type: "abProbeVersion" }, { timeoutMs: 6000 }).catch(() => null);
    check("[version] the reloaded copy answers the new op", Boolean(pB && pB.v === 2), JSON.stringify(pB).slice(0, 60));
  } finally {
    await agent.close().catch(() => {});
    await bridge.stop().catch(() => {});
    fs.rmSync(extDir, { recursive: true, force: true });
  }
}

try {
  await arm("plain", 8921, []);
  await arm("rescue", 8923, ["--disable-features=ExtensionDisableUnsupportedDeveloper"]);
  await versionArms();
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
