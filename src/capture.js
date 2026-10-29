// Identity capture from the user's own Chrome.
//
// Three capture paths, tried in order by captureIdentity():
//   1. live            — the user's Chrome runs with --remote-debugging-port
//                        (only possible on a non-default data dir since 136+).
//   2. extension-bridge — chrome.cookies in the user's own browser, values
//                        decrypted by Chrome; localStorage read from disk.
//   3. offline         — no CDP, no extension. Reads the Cookies DB directly:
//                        accurate metadata, ciphertext values (Chrome 127+
//                        app-bound encryption, v20 prefix). Reported as
//                        unusable, never faked.
//
// There is deliberately NO "copy the profile and launch our own Chrome" path.
// It was tried and measured (2026-10-14, Chrome 155.0.8059.40): a Chrome that
// opens a copied profile cannot unwrap the app-bound keys and wipes every row
// of the copy's cookie DB (3550 rows -> 0 after launch+close, same file size).
// It then mints a fresh anonymous session for whichever site you visit, so
// Network.getAllCookies returns plausible plaintext that is NOT the user's.
// That failure mode is worse than an error, because it silently fabricates
// an identity. The user's original profile is unaffected by the experiment.
//
// This module never writes to the user's profile. The only write-back path is
// writeback.js, and it is additive (new cookies for origins the user does not
// already have).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { readSqliteTable } from "../cookie-mcp/sqlite-reader.js";
import { readLocalStorage } from "./localstorage-reader.js";

export const CHROME_EXE =
  process.env.AGENT_BROWSER_CHROME ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

export const DEFAULT_PORT = 9222;

function debugLog(...args) {
  if (process.env.AGENT_BROWSER_DEBUG) console.error("[capture]", ...args);
}

// Does a cookie domain belong to any of the wanted hosts? Ports are stripped
// because cookies never carry one, and a leading dot is a parent-domain cookie.
function hostMatchesAny(cookieDomain, hosts) {
  const d = cookieDomain.replace(/^\./, "").replace(/:\d+$/, "").toLowerCase();
  return hosts.some((h) => {
    const hh = h.replace(/^\./, "").replace(/:\d+$/, "").toLowerCase();
    return d === hh || d.endsWith("." + hh) || hh.endsWith("." + d);
  });
}

export async function probePort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function defaultProfileDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return {
    chrome: path.join(local, "Google", "Chrome", "User Data"),
    edge: path.join(local, "Microsoft", "Edge", "User Data"),
  };
}

function findCookiesFile(profileRoot) {
  const candidates = [
    path.join(profileRoot, "Default", "Network", "Cookies"),
    path.join(profileRoot, "Default", "Cookies"),
    path.join(profileRoot, "Network", "Cookies"),
    path.join(profileRoot, "Cookies"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Profile N variants
  try {
    for (const entry of fs.readdirSync(profileRoot)) {
      if (!/^Profile \d+$/.test(entry)) continue;
      const c = path.join(profileRoot, entry, "Network", "Cookies");
      if (fs.existsSync(c)) return c;
    }
  } catch {}
  return null;
}

// Returns the live Cookies DB path. No copy needed: the file is readable while
// Chrome runs (verified — fs.openSync("r") on the live DB returns the SQLite
// header). What is NOT readable is the *contents* of the value column: Chrome
// 127+ app-bound-encrypts cookies (v20 prefix), so another process gets
// ciphertext only.
function snapshotCookiesFile(profileRoot) {
  const src = findCookiesFile(profileRoot);
  if (!src) return null;
  try {
    fs.accessSync(src, fs.constants.R_OK);
    return src;
  } catch {
    return null;
  }
}

export function findUserProfile() {
  const dirs = defaultProfileDirs();
  for (const [name, root] of Object.entries(dirs)) {
    if (fs.existsSync(root)) return { browser: name, root };
  }
  return null;
}

// Live capture over CDP. Returns { mode, cookies, storages, origins }.
// origins: [{ origin, localStorage: {...} }] for whitelisted sites.
export async function captureLive({ port = DEFAULT_PORT, origins = [], userAgent } = {}) {
  const version = await probePort(port);
  if (!version) throw new Error(`no CDP endpoint on 127.0.0.1:${port}`);
  debugLog("cdp version", version.Browser);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    ...(userAgent ? { userAgent } : {}),
  });
  try {
    const contexts = browser.contexts();
    if (contexts.length === 0) throw new Error("user browser has no open context");
    const context = contexts[0];

    // Cookies: connectOverCDP attaches to the live context, so context.cookies()
    // returns the real, currently-valid cookies (not a fresh storageState).
    const cookies = await context.cookies();
    debugLog("live cookies", cookies.length);

    // localStorage / sessionStorage / IndexedDB per origin. Only for origins
    // the caller whitelisted — this is the authorization boundary.
    const storages = [];
    for (const origin of origins) {
      const page = await context.newPage();
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 10000 });
        const data = await page.evaluate(() => {
          const dump = (store) => {
            const out = {};
            try {
              for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                out[k] = store.getItem(k);
              }
            } catch {}
            return out;
          };
          return {
            localStorage: dump(window.localStorage),
            sessionStorage: dump(window.sessionStorage),
          };
        });
        storages.push({ origin, ...data });
      } catch (e) {
        debugLog("origin capture failed", origin, e.message);
        storages.push({ origin, error: e.message });
      } finally {
        await page.close().catch(() => {});
      }
    }

    return { mode: "live", cookies, storages, endpoint: version.webSocketDebuggerUrl };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Capture identity for the given hosts. Live CDP first; offline metadata as a
// declared-degraded fallback.
//
// hosts:  cookie domains to return, e.g. ["github.com"].
// origins: origins to navigate to in the user's browser when reading
//          localStorage. Omit to read cookies only.
// localStorage from the user's profile on disk (plain leveldb — no CDP, no
// window, no decryption). Entries are grouped per wanted host, subdomains
// merged (www over apex), so the agent's second profile inherits the device
// state that would otherwise make it look like a brand-new machine.
async function diskStoragesFor(hosts) {
  try {
    const profile = findUserProfile();
    if (!profile) return [];
    const ls = await readLocalStorage({ profileRoot: profile.root });
    const out = [];
    for (const h of hosts) {
      const bare = h.replace(/^\./, "").replace(/:\d+$/, "").toLowerCase();
      const merged = {};
      const origins = Object.keys(ls.byOrigin).filter((o) => {
        try {
          const host = new URL(o).hostname.toLowerCase();
          return host === bare || host.endsWith("." + bare);
        } catch {
          return false;
        }
      });
      // Apex first so a www-prefixed origin overwrites it.
      origins.sort((a, b) => (a.length - b.length));
      for (const o of origins) Object.assign(merged, ls.byOrigin[o]);
      if (Object.keys(merged).length) {
        out.push({ origin: `https://${bare}`, localStorage: merged, sessionStorage: {} });
      }
    }
    if (ls.incomplete) debugLog("localStorage read incomplete:", JSON.stringify(ls.fileErrors || []).slice(0, 200));
    return out;
  } catch (e) {
    debugLog("disk localStorage read failed:", e.message);
    return [];
  }
}

export async function captureIdentity({ port = DEFAULT_PORT, hosts = [], origins = [], bridge = null, captureLocalStorage = true } = {}) {
  if (hosts.length === 0) throw new Error("captureIdentity needs at least one host");

  const wantOrigins = origins.length
    ? origins
    : hosts.map((h) => `https://${h.replace(/^\./, "")}`);

  // 1. Live CDP, if the user's Chrome exposes a port. Chrome 136+ refuses this
  //    on the default profile, so it is no longer the only usable path.
  if (await probePort(port)) {
    try {
      const live = await captureLive({ port, origins: wantOrigins });
      const cookies = live.cookies.filter((c) => hostMatchesAny(c.domain, hosts));
      return { ...live, mode: "live", cookies, capturedHosts: hosts };
    } catch (e) {
      debugLog("live capture failed:", e.message);
    }
  }

  // 2. Extension bridge: chrome.cookies.getAll, so Chrome unwraps the values
  //    itself and the default-profile port restriction does not apply.
  if (bridge) {
    try {
      if (!(await bridge.ready())) {
        for (let i = 0; i < 8 && !(await bridge.ready()); i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (await bridge.ready()) {
        const all = await bridge.cookies(hosts);
        const cookies = all.filter((c) => hostMatchesAny(c.domain, hosts));
        if (cookies.length) {
          const storages = captureLocalStorage ? await diskStoragesFor(hosts) : [];
          return {
            mode: "extension-bridge",
            cookies,
            storages,
            capturedHosts: hosts,
            usable: true,
            note: storages.length
              ? "cookies came from chrome.cookies in the user's own browser; localStorage read from the profile on disk (sessionStorage is memory-only and cannot be read this way)"
              : "cookies came from chrome.cookies in the user's own browser",
          };
        }
        debugLog("bridge connected but returned no cookies for", hosts.join(","));
      }
    } catch (e) {
      debugLog("bridge capture failed:", e.message);
    }
  }

  // 3. Offline. Metadata is real; values are v20 ciphertext. The caller must
  //    treat this as "no identity available" rather than a silent success.
  const off = await captureOffline({ origins: wantOrigins, hosts });
  return {
    ...off,
    capturedHosts: hosts,
    reason: `no CDP endpoint on 127.0.0.1:${port} and no extension bridge answer; ${off.disk.length} cookie rows exist on disk for these hosts but their values are app-bound encrypted (v20)`,
  };
}

// Offline capture: cookie metadata read straight from the profile DB. Values
// are Chrome-encrypted and there is no way for another process to unwrap them,
// so this is a census, not an identity. `cookies` is always empty on purpose —
// returning anything there would be fabricated.
export async function captureOffline({ origins = [], hosts = [] } = {}) {
  const profile = findUserProfile();
  if (!profile) throw new Error("no Chrome/Edge profile directory found");
  const cookiesFile = snapshotCookiesFile(profile.root);
  if (!cookiesFile) throw new Error(`no Cookies DB under ${profile.root}`);

  let disk = [];
  let diskIncomplete = false;
  try {
    const rows = await readSqliteTable(cookiesFile, "cookies");
    if (rows.decodeFailures > 0) diskIncomplete = true;
    disk = rows
      .filter((r) => hosts.length === 0 || hostMatchesAny(r.host_key, hosts))
      .map((r) => ({ domain: r.host_key, name: r.name, path: r.path, secure: r.is_secure, httpOnly: r.is_httponly }));
  } catch (e) {
    diskIncomplete = true;
    debugLog("disk census failed:", e.message);
  }

  return {
    mode: "offline",
    browser: profile.browser,
    profileRoot: profile.root,
    cookiesFile,
    origins,
    cookies: [],
    disk,
    diskIncomplete,
    usable: false,
    note: "the DB is readable, but Chrome 127+ app-bound-encrypts cookie values (v20); only Chrome can unwrap them, so this path yields no usable sessions",
  };
}

export async function listLoggedInOrigins({ port = DEFAULT_PORT } = {}) {
  const version = await probePort(port);
  if (!version) return { reachable: false, origins: [] };
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    if (!context) return { reachable: true, origins: [] };
    const cookies = await context.cookies();
    const byHost = new Map();
    for (const c of cookies) {
      if (!c.value) continue;
      const host = c.domain.replace(/^\./, "");
      const n = (byHost.get(host) || 0) + 1;
      byHost.set(host, n);
    }
    const origins = [...byHost.entries()]
      .filter(([, n]) => n >= 2) // 2+ cookies ≈ a real session, not a tracker
      .sort((a, b) => b[1] - a[1])
      .map(([host, count]) => ({ host, cookies: count }));
    return { reachable: true, origins };
  } finally {
    await browser.close().catch(() => {});
  }
}

// CLI: node src/capture.js --list  |  node src/capture.js --origins https://a.com,https://b.com --out x.json
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("capture.js")) {
  const args = process.argv.slice(2);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

  try {
    if (args.includes("--list")) {
      const out = await listLoggedInOrigins();
      if (!out.reachable) {
        console.error("user Chrome not reachable on 127.0.0.1:9222 — start it with --remote-debugging-port=9222");
        process.exit(2);
      }
      console.log(JSON.stringify(out.origins, null, 2));
    } else {
      const originsArg = args[args.indexOf("--origins") + 1] || "";
      const origins = originsArg ? originsArg.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const outIdx = args.indexOf("--out");
      const out = outIdx > -1 ? args[outIdx + 1] : null;
      const result = await captureLive({ origins });
      const json = JSON.stringify(result, null, 2);
      if (out) {
        fs.writeFileSync(out, json);
        console.error(`captured ${result.cookies.length} cookies, ${result.storages.length} origins -> ${out}`);
      } else {
        console.log(json);
      }
    }
  } catch (e) {
    console.error("capture failed:", e.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}
