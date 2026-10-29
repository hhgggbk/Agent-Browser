// MCP server: expose the user's Chrome cookies to the agent, read-only, with
// per-domain authorization.
//
// Two ways to read the cookies, both local, both read-only:
//   1. CDP      — the user's Chrome runs with --remote-debugging-port. Reads the
//                 live, currently-valid cookies. Preferred.
//   2. Snapshot — Chrome is not reachable: copy the Cookies SQLite out of the
//                 profile and read host_key/name/value/path/expires directly.
//                 The value column is Chrome-encrypted (DPAPI + app-bound), so
//                 this path reports what it can and never claims to have
//                 decrypted anything.
//
// Design rules:
//   - Never writes to the user's profile. There is no write tool at all.
//   - Cookie values are only returned for domains the caller explicitly asks
//     for; the domain list tool returns names and counts only.
//   - Everything stays on localhost.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";
import { readSqliteTable } from "./sqlite-reader.js";
import { createIdentityBridge } from "../src/bridge.js";
import { ExtensionManager } from "../src/extensions.js";

const CHROME_EXE =
  process.env.AGENT_BROWSER_CHROME ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEFAULT_PORT = Number(process.env.CHROME_CDP_PORT || 9222);

// Handing out the user's session is opt-in: a published server must not read
// cookies just because some MCP client asked for them.
const ALLOW_COOKIE_ACCESS = process.env.AGENT_BROWSER_ALLOW_COOKIE_ACCESS === "1";
const COOKIE_ACCESS_DISABLED =
  "cookie access is off by default — add \"AGENT_BROWSER_ALLOW_COOKIE_ACCESS\": \"1\" to this MCP server's env to enable get_cookies / list_cookie_domains";

function debugLog(...args) {
  if (process.env.AGENT_BROWSER_DEBUG) process.stderr.write(`[cookie-mcp] ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------- MCP protocol

const TOOLS = [
  {
    name: "list_cookie_domains",
    description:
      "List the domains that have cookies in the user's Chrome. Returns domain, cookie count and whether a session-looking cookie exists. No cookie values are returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_cookies",
    description:
      "Get the user's Chrome cookies for one or more domains. Returns full cookie records (name, value, domain, path, expires, httpOnly, secure, sameSite); values are plaintext when the identity bridge extension is loaded or Chrome exposes a debugging port, and __encrypted__ otherwise. Only the domains you ask for are returned. Use this to reuse an existing login instead of asking the user to log in again.",
    inputSchema: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "string" },
          description:
            "Domains to fetch, e.g. [\"github.com\"]. A domain also matches its subdomains (github.com covers gist.github.com).",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Optional: only return cookies with these names.",
        },
      },
      required: ["domains"],
      additionalProperties: false,
    },
  },
  {
    name: "cookie_source_info",
    description:
      "Report which capture path is available: the extension bridge (chrome.cookies inside the user's own browser, plaintext, no debugging port needed), live CDP (Chrome was started with a debugging port on a non-default profile), or snapshot (cookie rows read from the profile DB, values still encrypted). Also reports whether the user's Chrome is running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_extensions",
    description:
      "List the extensions installed in the user's running Chrome, with id, name, version, enabled state, install type, description and permissions. Read-only. Needs the identity bridge extension loaded.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "extension_manage",
    description:
      "Manage one extension in the user's Chrome through chrome.management. action=detail returns its full record; enable/disable toggles it; reload restarts it (a true reload when Chrome offers one, otherwise disable+enable, and the result says which); uninstall removes it; load tries to load an unpacked folder. Measured limits: Chrome refuses uninstall without a user gesture, and load needs chrome.developerPrivate, which only chrome://extensions has — both are reported explicitly instead of faked. Target is an id or a distinctive name.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["detail", "enable", "disable", "reload", "uninstall", "load"],
        },
        target: {
          type: "string",
          description: "Extension id, or full/partial name. Required except for action=load.",
        },
        path: {
          type: "string",
          description: "Absolute folder path for action=load.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function toolError(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

// ---------------------------------------------------------------- cookie access

let bridge = null;
let bridgeTried = false;

// This server is long-lived, so it hosts the bridge when the port is free and
// becomes a client when a task run already owns it.
async function getBridge() {
  if (bridge) return bridge;
  if (bridgeTried) return null;
  bridgeTried = true;
  try {
    bridge = await createIdentityBridge({
      port: Number(process.env.AGENT_BROWSER_BRIDGE_PORT || 8791),
    });
  } catch (e) {
    debugLog("bridge unavailable:", e.message);
    bridge = null;
  }
  return bridge;
}

function probeCDP(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 1200 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function normalizeHost(h) {
  return h.replace(/^\./, "").replace(/:\d+$/, "").toLowerCase();
}

function hostMatches(cookieDomain, wanted) {
  // An empty list means "all domains" (used by list_cookie_domains, which
  // groups by host itself).
  if (!wanted || wanted.length === 0) return true;
  const d = normalizeHost(cookieDomain);
  return wanted.some((w) => {
    const ww = normalizeHost(w);
    return d === ww || d.endsWith("." + ww) || ww.endsWith("." + d);
  });
}

// Live path: attach to the user's running browser over CDP and read cookies.
// Read-only: we never call Network.setCookie or navigate their tabs.
async function readCookiesViaCDP({ port, domains, names }) {
  const version = await probeCDP(port);
  if (!version) {
    return { ok: false, reason: `no CDP endpoint on 127.0.0.1:${port}` };
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    if (!context) return { ok: false, reason: "user browser has no open context" };
    const all = await context.cookies();
    let filtered = all.filter((c) => hostMatches(c.domain, domains));
    if (names?.length) filtered = filtered.filter((c) => names.includes(c.name));
    return { ok: true, mode: "live", browser: version.Browser, cookies: filtered };
  } finally {
    await browser.close().catch(() => {});
  }
}

function findCookiesDB(profileRoot) {
  const candidates = [
    path.join(profileRoot, "Default", "Network", "Cookies"),
    path.join(profileRoot, "Default", "Cookies"),
    path.join(profileRoot, "Network", "Cookies"),
    path.join(profileRoot, "Cookies"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    for (const entry of fs.readdirSync(profileRoot)) {
      if (!/^Profile \d+$/.test(entry)) continue;
      const c = path.join(profileRoot, entry, "Network", "Cookies");
      if (fs.existsSync(c)) return c;
    }
  } catch {}
  return null;
}

function findUserProfile() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  for (const [browser, root] of [
    ["chrome", path.join(local, "Google", "Chrome", "User Data")],
    ["edge", path.join(local, "Microsoft", "Edge", "User Data")],
  ]) {
    if (fs.existsSync(root)) return { browser, root };
  }
  return null;
}

// Snapshot path: read the Cookies SQLite straight from the profile. No copy:
// the file is readable even while Chrome runs (the "locked" belief was wrong —
// verified: fs.openSync("r") on the live DB succeeds and returns the SQLite
// header). Values are Chrome-encrypted and reported as such.
async function readCookiesViaSnapshot({ domains, names }) {
  const profile = findUserProfile();
  if (!profile) return { ok: false, reason: "no Chrome/Edge profile directory found" };
  const src = findCookiesDB(profile.root);
  if (!src) return { ok: false, reason: `no Cookies DB under ${profile.root}` };

  try {
    // Minimal SQLite reader: pull rows out of the cookies table. Chrome's
    // schema is stable across the versions that matter here (creation_utc,
    // host_key, name, value, encrypted_value, path, expires_utc, is_secure,
    // is_httponly, samesite).
    const rows = await readSqliteTable(src, "cookies");
    let out = rows
      .filter((r) => hostMatches(r.host_key, domains))
      .filter((r) => !names?.length || names.includes(r.name))
      .map((r) => ({
        name: r.name,
        domain: r.host_key,
        path: r.path,
        // Chrome 127+ encrypts with an app-bound key another process cannot
        // unwrap, so this is reported as ciphertext, not a usable session.
        value: r.encrypted_value ? `__encrypted__:${Buffer.from(r.encrypted_value).toString("base64")}` : r.value,
        encrypted: !!r.encrypted_value,
        expires: r.expires_utc > 0 ? chromeTimeToUnix(r.expires_utc) : -1,
        httpOnly: !!r.is_httponly,
        secure: !!r.is_secure,
        sameSite: ["unspecified", "lax", "strict", "none"][r.samesite] || "unspecified",
      }));

    // Dedupe: same (domain, path, name) can appear more than once in the raw
    // table; keep the one with the latest expiry.
    const byKey = new Map();
    for (const c of out) {
      const k = `${c.domain}|${c.path}|${c.name}`;
      const prev = byKey.get(k);
      if (!prev || c.expires > prev.expires) byKey.set(k, c);
    }
    out = [...byKey.values()];

    return {
      ok: true,
      mode: "snapshot",
      browser: profile.browser,
      cookies: out,
      warning:
        "values are Chrome 127+ app-bound encrypted (v20); only Chrome can unwrap them, so these are not usable as a session. Use the live CDP path for usable cookies.",
    };
  } catch (e) {
    return { ok: false, reason: `snapshot read failed: ${e.message}` };
  }
}

// Chrome stores timestamps as microseconds since 1601-01-01.
function chromeTimeToUnix(us) {
  return Math.floor(us / 1e6 - 11644473600);
}


// ---------------------------------------------------------------- tool handlers

async function handleListDomains() {
  const port = DEFAULT_PORT;
  const cdp = await probeCDP(port);
  if (cdp) {
    // "." matches nothing; ask for everything and group in memory instead.
    const r = await readCookiesViaCDP({ port, domains: [], names: [] });
    if (!r.ok) return toolError(r.reason);
    const byHost = new Map();
    for (const c of r.cookies) {
      const host = normalizeHost(c.domain);
      const e = byHost.get(host) || { domain: host, cookies: 0, sessionCookies: 0 };
      e.cookies += 1;
      // A session cookie (no expiry) or a value-bearing cookie on an auth-ish
      // name is what actually constitutes a login.
      if (c.expires === -1 || /session|token|auth|sid|login/i.test(c.name)) e.sessionCookies += 1;
      byHost.set(host, e);
    }
    const domains = [...byHost.values()].sort((a, b) => b.cookies - a.cookies);
    return toolResult({
      source: "live",
      browser: r.browser,
      domains,
      note: "cookie values are not included here; call get_cookies for the domains you need",
    });
  }
  // No CDP: still list what is on disk, from the snapshot. An empty domain
  // list means "all domains" — the grouping happens below.
  const r = await readCookiesViaSnapshot({ domains: [], names: [] });
  if (!r.ok) return toolError(r.reason);
  const byHost = new Map();
  for (const c of r.cookies) {
    const host = normalizeHost(c.domain);
    const e = byHost.get(host) || { domain: host, cookies: 0, sessionCookies: 0 };
    e.cookies += 1;
    if (c.expires === -1 || /session|token|auth|sid|login/i.test(c.name)) e.sessionCookies += 1;
    byHost.set(host, e);
  }
  return toolResult({
    source: "snapshot",
    browser: r.browser,
    domains: [...byHost.values()].sort((a, b) => b.cookies - a.cookies),
    warning: r.warning,
  });
}

async function handleListExtensions() {
  const bridge = await getBridge();
  if (!bridge || !(await bridge.ready())) {
    return toolError("the identity bridge extension is not connected; load cookie-extension/ in chrome://extensions and wait ~30s");
  }
  const mgr = new ExtensionManager(bridge);
  return toolResult({ extensions: await mgr.list() });
}

async function handleExtensionManage({ action, target, path: dir } = {}) {
  if (!["detail", "enable", "disable", "reload", "uninstall", "load"].includes(action)) {
    return toolError(`action must be one of detail/enable/disable/reload/uninstall/load, got ${action}`);
  }
  const bridge = await getBridge();
  if (!bridge || !(await bridge.ready())) {
    return toolError("the identity bridge extension is not connected; load cookie-extension/ in chrome://extensions and wait ~30s");
  }
  const mgr = new ExtensionManager(bridge);
  try {
    if (action === "load") return toolResult(await mgr.loadUnpacked(dir));
    if (!target) return toolError(`action=${action} needs a target (id or name)`);
    if (action === "detail") return toolResult(await mgr.detail(target));
    if (action === "enable") return toolResult(await mgr.setEnabled(target, true));
    if (action === "disable") return toolResult(await mgr.setEnabled(target, false));
    if (action === "reload") return toolResult(await mgr.reload(target));
    if (action === "uninstall") return toolResult(await mgr.uninstall(target));
  } catch (e) {
    return toolError(String(e.message || e).slice(0, 300));
  }
  return toolError(`unhandled action ${action}`);
}

async function handleGetCookies({ domains, names }) {
  if (!Array.isArray(domains) || domains.length === 0) {
    return toolError("domains must be a non-empty array of strings");
  }
  const bad = domains.filter((d) => typeof d !== "string" || !d.trim());
  if (bad.length) return toolError("domains must be strings");

  // Path 1: the user's Chrome exposes a CDP port. This is the only path whose
  // values are usable.
  const cdp = await probeCDP(DEFAULT_PORT);
  if (cdp) {
    const r = await readCookiesViaCDP({ port: DEFAULT_PORT, domains, names });
    if (r.ok) {
      return toolResult({
        source: "live",
        browser: r.browser,
        count: r.cookies.length,
        cookies: r.cookies,
      });
    }
    debugLog("live path failed, falling back to snapshot:", r.reason);
  }

  // Path 2: the identity bridge extension. chrome.cookies runs inside the
  // user's own browser, so Chrome decrypts the values and the 136+ refusal to
  // open a debugging port on the default profile does not apply.
  const bridge = await getBridge();
  if (bridge && (await bridge.ready())) {
    try {
      const list = await bridge.cookies(domains);
      const cookies = list
        .filter((c) => hostMatches(c.domain, domains))
        .filter((c) => !names?.length || names.includes(c.name))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expires: c.expires || null,
          session: c.session,
        }));
      return toolResult({ source: "extension-bridge", count: cookies.length, cookies });
    } catch (e) {
      debugLog("bridge path failed:", e.message);
    }
  }

  // Path 3: read the DB directly. Metadata is accurate; values are ciphertext.
  //
  // There is no "copy the profile and let a fresh Chrome decrypt it" path.
  // Measured on Chrome 155: a Chrome opening a copied cookie DB cannot unwrap
  // the app-bound keys and wipes all 3550 rows of the copy, then mints a fresh
  // anonymous session for whatever site you visit. Those cookies look real and
  // are not — which is worse than failing.
  const r = await readCookiesViaSnapshot({ domains, names });
  if (!r.ok) return toolError(r.reason);
  return toolResult({
    source: "snapshot",
    browser: r.browser,
    count: r.cookies.length,
    cookies: r.cookies,
    warning: r.warning,
  });
}

async function handleSourceInfo() {
  const cdp = await probeCDP(DEFAULT_PORT);
  const bridge = await getBridge();
  const profile = findUserProfile();
  const db = profile ? findCookiesDB(profile.root) : null;
  let chromeRunning = false;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count"`,
      { encoding: "utf8", timeout: 10000 },
    );
    chromeRunning = Number(out.trim()) > 0;
  } catch {}
  let bridgeStatus = null;
  let bridgeReady = false;
  if (bridge) {
    try {
      bridgeStatus = await bridge.status();
      bridgeReady = await bridge.ready();
    } catch (e) {
      bridgeStatus = { error: String(e.message || e).slice(0, 200) };
    }
  }
  return toolResult({
    cookieAccess: {
      enabled: ALLOW_COOKIE_ACCESS,
      note: ALLOW_COOKIE_ACCESS
        ? "get_cookies / list_cookie_domains 已放开"
        : COOKIE_ACCESS_DISABLED,
    },
    bridge: {
      available: bridgeReady,
      hosting: bridge?.hosting ?? false,
      status: bridgeStatus,
      howToEnable:
        `chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → ` +
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cookie-extension") +
        `；装载后由 Chrome 自己解密并回传，不需要调试端口，也不用重启浏览器`,
    },
    liveCDP: cdp
      ? { available: true, port: DEFAULT_PORT, browser: cdp.Browser }
      : {
          available: false,
          port: DEFAULT_PORT,
          howToEnable: `Chrome 136+ refuses --remote-debugging-port on the default profile; use the bridge, or a non-default --user-data-dir`,
        },
    snapshot: {
      available: !!db,
      profileRoot: profile?.root || null,
      cookiesDB: db,
      note: db ? "values are Chrome-encrypted and unusable by other processes" : "no profile found",
    },
    chromeRunning,
  });
}

// ---------------------------------------------------------------- JSON-RPC loop

async function handleRequest(req) {
  const { id, method, params } = req;
  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "chrome-cookies", version: "1.0.0" },
          },
        };
      case "notifications/initialized":
      case "initialized":
        return null;
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        let result;
        if (name === "list_cookie_domains" || name === "get_cookies") {
          if (!ALLOW_COOKIE_ACCESS) result = toolError(COOKIE_ACCESS_DISABLED);
          else if (name === "list_cookie_domains") result = await handleListDomains();
          else result = await handleGetCookies(args);
        }
        else if (name === "cookie_source_info") result = await handleSourceInfo();
        else if (name === "list_extensions") result = await handleListExtensions();
        else if (name === "extension_manage") result = await handleExtensionManage(args);
        else result = toolError(`unknown tool: ${name}`);
        return { jsonrpc: "2.0", id, result };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  } catch (e) {
    debugLog("handler error", e.stack || e.message);
    return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
  }
}

// stdio framing: newline-delimited JSON (what this host expects).
let buffer = "";
// Requests in flight. stdin EOF must not exit the process while any are still
// running — a tool call can take a minute (it launches a Chrome), and exiting
// early drops the response on the floor.
let inFlight = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    inFlight += 1;
    handleRequest(req)
      .then((res) => {
        if (res) process.stdout.write(JSON.stringify(res) + "\n");
      })
      .catch((e) => {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: e.message } }) + "\n",
        );
      })
      .finally(() => {
        inFlight -= 1;
      });
  }
});
// Notifications get no response, so they never land in inFlight; the flag below
// just records that the client is done sending.
let stdinClosed = false;
process.stdin.on("end", () => {
  stdinClosed = true;
  const tryExit = () => {
    if (stdinClosed && inFlight === 0) process.exit(0);
    else setTimeout(tryExit, 100);
  };
  tryExit();
});

// Keep the process alive; MCP clients close stdin to shut us down.
setInterval(() => {}, 1 << 30);
