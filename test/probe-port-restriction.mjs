// INCONCLUSIVE BY CONSTRUCTION — kept as evidence, not as a result.
//
// This was meant to measure how Chrome decides "this --user-data-dir IS the
// default one, so refuse the debugging port". It cannot: Chrome resolves the
// default data dir through the Windows known-folder API (SHGetKnownFolderPath),
// which does not follow the child's LOCALAPPDATA. So a throwaway directory under
// a fake LOCALAPPDATA is never "the default", and every launch here — including
// the exact-path control — opens its port. There is no positive control: the
// harness could not have printed REFUSED even if all six spellings were blocked.
//
// Also note the original run seeded a session cookie (no `expires`), so
// "marker=GONE" was Chrome correctly not restoring a session cookie, not a
// deletion. See test/probe-cookie-durability.mjs for that control.
//
// Settling the actual question needs the real default profile, which means
// quitting the user's Chrome first — do not run this as if it answered anything.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright-core";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const lines = [];
const log = (s) => { lines.push(s); process.stdout.write(s + "\n"); };

const ROOT = path.join("C:", "tmp", `ab-bypass-${process.pid}`);
const LA_DEFAULT = path.join(ROOT, "laDefault");   // P is the default under this LOCALAPPDATA
const LA_OTHER = path.join(ROOT, "laOther");       // P is NOT the default under this one
const P = path.join(LA_DEFAULT, "Google", "Chrome", "User Data");

fs.mkdirSync(P, { recursive: true });
fs.mkdirSync(LA_OTHER, { recursive: true });

function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// Kill by the unique ROOT token only. -like treats backslashes literally, so
// matching on a full path would miss forward-slash and 8.3 spellings; the token
// appears in every variant's command line and in nothing else on this machine.
function killChromeOn() {
  const token = path.basename(ROOT);
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${token}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 25000 }); } catch {}
}

async function withChrome(userDataDirArg, localAppdata, port, fn) {
  const child = spawn(CHROME, [
    `--user-data-dir=${userDataDirArg}`,
    `--remote-debugging-port=${port}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--no-sandbox",
    "--password-store=basic",
    "--use-mock-keychain",
    "about:blank",
  ], {
    env: { ...process.env, LOCALAPPDATA: localAppdata },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString(); });

  let opened = false;
  for (let i = 0; i < 45 && !child.killed; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await getJson(`http://127.0.0.1:${port}/json/version`)) { opened = true; break; }
  }
  let result;
  if (opened) {
    try {
      result = await fn();
    } catch (e) {
      result = { error: e.message.slice(0, 60) };
    }
    // Ask Chrome to shut down on its own so the cookie DB gets checkpointed.
    // Force-killing here would leave unflushed rows and make "cookie is gone"
    // mean "we never wrote it" instead of "Chrome dropped it".
    try {
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const ctx = b.contexts()[0];
      if (ctx) {
        const p = ctx.pages()[0] || (await ctx.newPage());
        const cdp = await ctx.newCDPSession(p);
        await cdp.send("Browser.close", {}).catch(() => {});
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2500));
  }
  killChromeOn();
  await new Promise((r) => setTimeout(r, 1500));
  return { opened, stderr, ...result };
}

// Is the marker actually in the SQLite file? Separates "never persisted" from
// "Chrome loaded the DB and dropped the row".
function diskHasMarker(dir, name) {
  for (const c of [
    path.join(dir, "Default", "Network", "Cookies"),
    path.join(dir, "Network", "Cookies"),
    path.join(dir, "Default", "Cookies"),
  ]) {
    if (!fs.existsSync(c)) continue;
    try {
      const buf = fs.readFileSync(c);
      const s = buf.toString("latin1");
      let n = 0, i = 0;
      while ((i = s.indexOf(name, i)) >= 0) { n++; i += name.length; }
      return { file: c, occurrences: n, bytes: buf.length };
    } catch (e) {
      return { file: c, error: e.code };
    }
  }
  return { missing: true };
}

// ---- Phase 1: seed a marker cookie while P is a non-default dir (port allowed).
log("=== phase 1: seed marker (P is non-default here) ===");
const seeded = await withChrome(P, LA_OTHER, 9850, async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9850");
  const ctx = b.contexts()[0];
  await ctx.addCookies([{ name: "ab_marker", value: "SEED_VALUE_9137", domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 30 * 86400 }]);
  const n = (await ctx.cookies()).length;
  await b.close();
  return { seededCount: n };
});
log(`  CDP on non-default dir: ${seeded.opened ? "OPEN" : "REFUSED"}  jar=${seeded.seededCount ?? "n/a"}`);
log("  marker on disk after clean close: " + JSON.stringify(diskHasMarker(P, "ab_marker")));
if (!seeded.opened) {
  const rel = seeded.stderr.split(/\r?\n/).filter((l) => /DevTools|debugging|default/i.test(l)).slice(0, 3);
  log("  stderr: " + (rel.join(" | ") || seeded.stderr.slice(0, 200)));
  // A stray dir named "User" next to "User Data" means the arg was split at the
  // space, i.e. a quoting problem rather than a Chrome policy.
  const stray = path.join(path.dirname(P), "User");
  log("  stray 'User' dir created? " + fs.existsSync(stray));
  log("  cannot seed; aborting");
  fs.writeFileSync("C:/tmp/ab-bypass-result.txt", lines.join("\n") + "\n");
  process.exit(1);
}
killChromeOn(P);
await new Promise((r) => setTimeout(r, 2500));

// ---- Phase 2: P becomes the default; try spelling variants of the same dir.
log("");
log("=== phase 2: P is now the DEFAULT; variant spellings ===");
const variants = [
  { label: "exact path (control)", dir: P },
  { label: "trailing dot", dir: P + "." },
  { label: "forward slashes", dir: P.replace(/\\/g, "/") },
  { label: "mixed case", dir: P.replace("User Data", "USER DATA") },
];

try {
  const out = execFileSync("cmd.exe", ["/c", "dir", "/X", path.dirname(P)], {
    encoding: "utf8", windowsVerbatimArguments: true, timeout: 20000,
  });
  const m = out.match(/([A-Za-z0-9]+~[A-Za-z0-9]+)\s+User Data/);
  if (m) variants.push({ label: "8.3 short name", dir: path.join(path.dirname(P), m[1]) });
  else log("(no 8.3 short name for the leaf: 8.3 generation may be off on C:)");
} catch (e) { log("short-name probe failed: " + e.message.slice(0, 70)); }

const junc = path.join(ROOT, "junc-profile");
try {
  // No windowsVerbatimArguments here: P contains a space ("User Data") and
  // needs quoting, which Node does for us by default.
  execFileSync("cmd.exe", ["/c", "mklink", "/J", junc, P], { encoding: "utf8", timeout: 20000 });
  variants.push({ label: "directory junction", dir: junc });
} catch (e) { log("junction create failed: " + e.message.slice(0, 70)); }

let port = 9851;
for (const v of variants) {
  const p = port++;
  const r = await withChrome(v.dir, LA_DEFAULT, p, async () => {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${p}`);
    const jar = await b.contexts()[0].cookies();
    const m = jar.find((c) => c.name === "ab_marker");
    await b.close();
    return { marker: m ? `ALIVE(${m.value})` : `GONE(jar=${jar.length})` };
  });
  const refused = /requires a non-default data directory/i.test(r.stderr);
  const onDisk = diskHasMarker(P, "ab_marker");
  log(`  ${v.label.padEnd(22)} port=${r.opened ? "OPEN   " : refused ? "REFUSED" : "timeout"}  marker=${(r.marker ?? "-").padEnd(22)} diskRows=${onDisk.occurrences ?? onDisk.error ?? "missing"}`);
}

fs.writeFileSync("C:/tmp/ab-bypass-result.txt", lines.join("\n") + "\n");
// Remove the junction with rmdir, which never follows into the target, before
// touching the tree recursively.
if (fs.existsSync(junc)) {
  try { execFileSync("cmd.exe", ["/c", "rmdir", junc], { stdio: "ignore", windowsVerbatimArguments: true, timeout: 15000 }); } catch {}
}
try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch {}
