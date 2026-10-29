// Which thing deleted the marker cookie: Chrome reopening the profile, or my
// own force-kill between phases? Four steps, one variable changed at a time.
//
//   1. seed P, clean close (Browser.close), check disk        -> baseline
//   2. reopen P with the SAME env, check jar + disk           -> pure reopen
//   3. force-kill lingering chrome, check disk                -> is my cleanup destructive?
//   4. reopen P with a DIFFERENT LOCALAPPDATA, check jar+disk  -> is the env switch what drops it?
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright-core";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const lines = [];
const log = (s) => { lines.push(s); process.stdout.write(s + "\n"); };

const ROOT = path.join("C:", "tmp", `ab-durable-${process.pid}`);
const LA_A = path.join(ROOT, "laA");
const LA_B = path.join(ROOT, "laB");
const P = path.join(LA_A, "Google", "Chrome", "User Data");
fs.mkdirSync(P, { recursive: true });
fs.mkdirSync(LA_B, { recursive: true });

function getJson(url, t = 1500) {
  return new Promise((res) => {
    const r = http.get(url, { timeout: t }, (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => { try { res(JSON.parse(b)); } catch { res(null); } }); });
    r.on("timeout", () => { r.destroy(); res(null); });
    r.on("error", () => res(null));
  });
}
function killLingering() {
  const token = path.basename(ROOT);
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${token}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 25000 }); } catch {}
}
function disk() {
  const f = path.join(P, "Default", "Network", "Cookies");
  if (!fs.existsSync(f)) return { file: "missing" };
  const buf = fs.readFileSync(f);
  const s = buf.toString("latin1");
  let n = 0, i = 0;
  while ((i = s.indexOf("ab_marker", i)) >= 0) { n++; i += 9; }
  return { bytes: buf.length, occurrences: n };
}

// Launch + optionally seed, then close cleanly via Browser.close.
async function step(label, { la, seed, port, doKill }) {
  const child = spawn(CHROME, [
    `--user-data-dir=${P}`, `--remote-debugging-port=${port}`,
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--no-sandbox", "--password-store=basic", "--use-mock-keychain", "about:blank",
  ], { env: { ...process.env, LOCALAPPDATA: la }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));

  let opened = false;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await getJson(`http://127.0.0.1:${port}/json/version`)) { opened = true; break; }
  }
  let jar = "n/a";
  if (opened) {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = b.contexts()[0];
    if (seed) await ctx.addCookies([{ name: "ab_marker", value: "SEED_VALUE_9137", domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 30 * 86400 }]);
    jar = (await ctx.cookies()).filter((c) => c.name === "ab_marker").length;
    // Clean shutdown so the DB is checkpointed.
    const p = ctx.pages()[0] || (await ctx.newPage());
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Browser.close", {}).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
  }
  const mid = disk();
  log(`${label}`);
  log(`   port=${opened ? "OPEN" : "no-port"} jarMarker=${jar}  disk(after clean close)=${JSON.stringify(mid)}`);
  if (doKill) {
    killLingering();
    await new Promise((r) => setTimeout(r, 2000));
    log(`   disk(after my Stop-Process -Force)=${JSON.stringify(disk())}`);
  }
  return { opened, stderr };
}

await step("1. seed + clean close (LA_A)", { la: LA_A, seed: true, port: 9871, doKill: false });
await step("2. reopen, SAME env, no force-kill (LA_A)", { la: LA_A, seed: false, port: 9872, doKill: true });
await step("3. reopen, DIFFERENT LOCALAPPDATA (LA_B)", { la: LA_B, seed: false, port: 9873, doKill: false });

fs.writeFileSync("C:/tmp/ab-durable-result.txt", lines.join("\n") + "\n");
killLingering();
await new Promise((r) => setTimeout(r, 1500));
try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch {}
