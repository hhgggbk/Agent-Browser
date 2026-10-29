// Is "--load-extension is dead on Chrome 155" still true? Extension.js ships
// `--disable-features=DisableLoadExtensionCommandLineSwitch` as standard
// equipment, and my Oct-15 note never tried that flag. Four arms, one
// apparatus, judged on a functional signal (the extension's own /hello to the
// bridge) rather than on a target appearing in the list:
//
//   1 none                    -> negative control: hello must NOT arrive
//   2 load-extension          -> reproduces the Oct-15 state
//   3 load-extension + flag   -> the claim under test
//   4 CDP Extensions.loadUnpacked -> positive control: the apparatus CAN see a
//      live worker, so arms 2/3 staying silent means something.
//
// Every arm gets its own copy of the extension directory: the bridge key lives
// inside it, so a shared dir would let one arm answer for another.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdentityBridge } from "../src/bridge.js";
import { CHROME_EXE } from "../src/capture.js";

const PORT = 8901;
const CDP = 9601;
const SRC = path.join(process.cwd(), "cookie-extension");
const fwd = (p) => p.replace(/\\/g, "/");

function freshExtCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ab-ple-${tag}-`));
  for (const f of ["manifest.json", "background.js", "probe.html", "probe.js"]) {
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  return dir;
}

async function waitForCDP(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function runArm(tag, mode, { headless = true } = {}) {
  const extDir = freshExtCopy(tag);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `ab-ple-${tag}-profile-`));
  const bridge = new IdentityBridge({ port: PORT, extensionDir: extDir });
  await bridge.start();

  const args = [
    `--user-data-dir=${fwd(profile)}`,
    `--remote-debugging-port=${CDP}`,
    ...(headless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-blink-features=AutomationControlled",
  ];
  if (mode.startsWith("load-extension")) {
    args.push(`--load-extension=${fwd(extDir)}`);
  }
  if (mode === "load-extension+flag") {
    args.push("--disable-features=DisableLoadExtensionCommandLineSwitch");
  }
  if (mode === "load-extension+flag+unsafe") {
    args.push(
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--enable-unsafe-extension-debugging",
    );
  }
  const proc = spawn(CHROME_EXE, args, { stdio: "ignore" });
  const out = { tag, mode, cdp: await waitForCDP() };

  if (mode === "cdp-loadunpacked") {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null);
    if (!b) out.loaded = "connectOverCDP failed";
    else {
      const sess = await b.newBrowserCDPSession().catch(() => null);
      const r = sess
        ? await sess.send("Extensions.loadUnpacked", { path: fwd(extDir) }).catch((e) => ({ err: e.message }))
        : { err: "no browser session" };
      out.loaded = r.id || `ERR ${String(r.err).slice(0, 60)}`;
      await b.close().catch(() => {});
    }
  }

  const start = Date.now();
  out.helloMs = null;
  while (Date.now() - start < 12000) {
    if (bridge.status().connected) { out.helloMs = Date.now() - start; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  const targets = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json()).catch(() => []);
  out.sw = targets.filter((t) => t.type === "service_worker").map((t) => t.url.slice(0, 60));
  out.extTargets = targets.filter((t) => String(t.url).startsWith("chrome-extension://")).length;

  await bridge.stop().catch(() => {});
  proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 800));
  // Children keep the profile locked briefly after the parent dies; rmSync
  // fails silently on Windows, so retry and report any survivor.
  const survivors = [];
  for (const dir of [profile, extDir]) {
    for (let i = 0; i < 8; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      if (!fs.existsSync(dir)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (fs.existsSync(dir)) survivors.push(path.basename(dir));
  }
  out.survivors = survivors;
  return out;
}

for (const [tag, mode, opts] of [
  ["1-none", "none"],
  ["2-load-extension", "load-extension"],
  ["3-flag", "load-extension+flag"],
  ["5-both-flags", "load-extension+flag+unsafe"],
  ["4-cdp", "cdp-loadunpacked"],
  ["6-headed-plain", "load-extension", { headless: false }],
  ["7-headed-flag", "load-extension+flag", { headless: false }],
]) {
  const r = await runArm(tag, mode, opts || {});
  console.log(JSON.stringify(r));
}
process.exit(0);
