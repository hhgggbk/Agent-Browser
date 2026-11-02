// agent-browser MCP front door: ONE stdio server in place of the two separate
// registrations (chrome-cookies + chrome-devtools). It spawns both back ends as
// child MCP servers, merges their tools/list and routes tools/call by name.
//
//   node src/mcp.js
//
// Nothing is reimplemented here: cookie/extension tools still run in
// cookie-mcp/server.js (including its AGENT_BROWSER_ALLOW_COOKIE_ACCESS gate),
// and the DevTools tools still run in the upstream chrome-devtools-mcp package.
// stdout carries JSON-RPC only; child stderr is forwarded with a prefix.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// Published default keeps the DevTools profile inside the project; an existing
// install can point at a profile it already has logins in.
const CDM_PROFILE = process.env.AGENT_BROWSER_CDM_PROFILE || path.join(ROOT, ".profiles", "cdm");
const CDM_BROWSER_URL = (process.env.AGENT_BROWSER_CDP_URL || "").trim();
// Without MCP roots from the client, the devtools back end only writes inside the
// OS temp dir and stalls waiting for a roots reply it will never get. Point this
// at the directory you want screenshots/traces written to.
const CDM_WORKSPACE = (process.env.AGENT_BROWSER_WORKSPACE || "").trim();
// Chrome 136+ ignores --remote-debugging-port on the default profile. The only
// door into a browser you already use is chrome://inspect/#remote-debugging,
// which writes DevToolsActivePort into the profile; --autoConnect reads it.
const CDM_USER_PROFILE = (process.env.AGENT_BROWSER_USER_PROFILE || "").trim();

async function cdpAnswers(base) {
  try {
    const r = await fetch(`${base.replace(/\/+$/, "")}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function userProfileReady(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, "DevToolsActivePort"));
}

const BACKENDS = {
  identity: {
    command: process.execPath,
    args: [path.join(ROOT, "cookie-mcp", "server.js")],
    cwd: ROOT,
    env: {},
  },
  devtools: {
    command: process.execPath,
    // Resolved at start time: attach when the configured port actually answers,
    // otherwise fall back to our own profile so a stale setting cannot break the
    // whole back end.
    resolveArgs: async () => {
      const entry = path.join(ROOT, "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js");
      const tail = CDM_WORKSPACE ? [`--workspace=${CDM_WORKSPACE}`] : [];
      if (CDM_BROWSER_URL && (await cdpAnswers(CDM_BROWSER_URL))) {
        return [entry, "--no-usage-statistics", `--browserUrl=${CDM_BROWSER_URL}`, ...tail];
      }
      // A browser the user already runs: chrome://inspect/#remote-debugging
      // writes DevToolsActivePort; --autoConnect + --userDataDir consumes it.
      if (userProfileReady(CDM_USER_PROFILE)) {
        return [entry, "--no-usage-statistics", "--autoConnect", `--userDataDir=${CDM_USER_PROFILE}`, ...tail];
      }
      if (CDM_BROWSER_URL) err(`no CDP at ${CDM_BROWSER_URL}; starting our own browser instead`);
      if (CDM_USER_PROFILE) err(`no DevToolsActivePort in ${CDM_USER_PROFILE}; enable chrome://inspect/#remote-debugging`);
      return [entry, "--no-usage-statistics", `--userDataDir=${CDM_PROFILE}`, ...tail];
    },
    cwd: path.join(ROOT, "node_modules", "chrome-devtools-mcp"),
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
  },
};

// Third back end is an external checkout, so it is opt-in via env. Its tool names
// are all prefixed: 7 of them collide with chrome-devtools-mcp (evaluate_script,
// navigate_page, new_page, select_page, take_screenshot, list_console_messages,
// list_network_requests), and prefixing only the clashing ones would leave a
// half-bare / half-prefixed mess.
const JS_REVERSE_ENTRY = (process.env.AGENT_BROWSER_JS_REVERSE_ENTRY || "").trim();
if (JS_REVERSE_ENTRY) {
  BACKENDS.jsreverse = {
    command: process.execPath,
    args: [JS_REVERSE_ENTRY],
    cwd: path.dirname(path.dirname(path.dirname(JS_REVERSE_ENTRY))),
    env: {},
    namespace: "jsr_",
  };
}

const PROTOCOL = "2024-11-05";
const children = new Map();          // backend -> {proc, nextId, pending, toolsReady}
const route = new Map();             // exposed tool name -> {backend, realName}
const err = (...a) => process.stderr.write(`[agent-browser] ${a.join(" ")}\n`);

async function startBackend(key) {
  if (children.has(key)) return children.get(key);
  const spec = BACKENDS[key];
  const args = spec.resolveArgs ? await spec.resolveArgs() : spec.args;
  if (!fs.existsSync(args[0])) {
    throw new Error(`backend ${key}: missing ${args[0]} (npm install first)`);
  }
  const proc = spawn(spec.command, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const child = { key, proc, nextId: 1, pending: new Map(), buf: "" };
  proc.stdout.on("data", (chunk) => onChildData(child, chunk));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[${key}] ${chunk}`));
  proc.on("exit", (code) => {
    children.delete(key);
    for (const [, p] of child.pending) p.reject(new Error(`backend ${key} exited (code ${code})`));
    child.pending.clear();
  });
  children.set(key, child);
  return child;
}

function onChildData(child, chunk) {
  child.buf += chunk.toString();
  let i;
  while ((i = child.buf.indexOf("\n")) >= 0) {
    const line = child.buf.slice(0, i).trim();
    child.buf = child.buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;               // notifications from a child: drop
    const p = child.pending.get(msg.id);
    if (!p) continue;
    child.pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
}

function callBackend(child, method, params, timeoutMs = 120000) {
  const id = child.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.pending.delete(id);
      reject(new Error(`backend ${child.key}: ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notifyBackend(child, method) {
  child.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

async function handshake(key) {
  const child = await startBackend(key);
  await callBackend(child, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: { tools: {} },
    clientInfo: { name: "agent-browser", version: PKG.version },
  }, 30000);
  notifyBackend(child, "notifications/initialized");
  return child;
}

// Build the merged tool table once; upstream wins its own names, and a genuine
// clash gets prefixed instead of silently shadowing.
async function tools() {
  if (route.size) return merged;
  merged = [];
  for (const key of Object.keys(BACKENDS)) {
    let child;
    try {
      child = await handshake(key);
    } catch (e) {
      err(`backend ${key} unavailable: ${e.message}`);
      continue;
    }
    const list = await callBackend(child, "tools/list", {}, 30000);
    const ns = BACKENDS[key].namespace || "";
    for (const t of list.tools || []) {
      let name = ns + t.name;
      if (route.has(name)) {
        name = `${key}_${t.name}`;
        err(`tool name clash on "${t.name}"; exposing it as "${name}"`);
      }
      route.set(name, { backend: key, realName: t.name });
      merged.push({ ...t, name });
    }
  }
  return merged;
}
let merged = null;

async function dispatch(name, args) {
  let r = route.get(name);
  if (!r) { await tools(); r = route.get(name); }
  if (!r) throw new Error(`unknown tool: ${name}`);
  const child = children.get(r.backend) || (await handshake(r.backend));
  return callBackend(child, "tools/call", { name: r.realName, arguments: args || {} });
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-browser", version: PKG.version },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  try {
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: await tools() } };
    if (method === "tools/call") {
      const result = await dispatch(params?.name, params?.arguments);
      return { jsonrpc: "2.0", id, result };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } };
  }
}

let open = 0;
let stdinEnded = false;
let stdinBuf = "";
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk.toString();
  const lines = stdinBuf.split("\n");
  stdinBuf = lines.pop();
  for (const line of lines.filter(Boolean)) {
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    open++;
    Promise.resolve(handle(req))
      .then((res) => { if (res) process.stdout.write(JSON.stringify(res) + "\n"); })
      .catch((e) => err(`handler error: ${e.stack || e}`))
      .finally(() => { open--; });
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  const drain = () => {
    if (open > 0) return setTimeout(drain, 100);
    for (const child of children.values()) child.proc.kill();
    process.exit(0);
  };
  drain();
});

// Keep the loop alive until a client closes stdin.
setInterval(() => {}, 1 << 30);
