// Identity bridge: a 127.0.0.1 server the loaded Chrome extension long-polls.
//
// Why this exists: Chrome 136+ refuses --remote-debugging-port on the default
// user data directory, so neither live CDP capture nor live CDP write-back can
// reach the browser the user is actually logged into, and the on-disk values
// are app-bound encrypted (v20). An extension with the "cookies" permission is
// the one channel Chrome authorizes by itself: values arrive plaintext, his
// browser never restarts, and nothing is written to his profile from outside.
//
// Threat model, stated honestly: binding to 127.0.0.1 plus a per-start shared
// key keeps remote hosts and casual local port-scanners out. It does NOT
// protect against malware already running as this user — that is the same
// trust boundary as the cookies themselves.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { borrowedSites } from "./site-lock.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, "..", "cookie-extension");

const DEFAULT_POLL_HOLD_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;

class Rejected extends Error {}

export class IdentityBridge {
  constructor({ port = 8791, extensionDir = EXT_DIR, key = crypto.randomBytes(16).toString("hex") } = {}) {
    this.port = port;
    this.extensionDir = extensionDir;
    this.key = key;
    this.server = null;
    this.held = null; // in-flight poll response, waiting for a request
    this.queue = []; // requests with no poll to answer them yet
    this.seq = 0;
    this.waiters = new Map(); // id -> {resolve, reject, timer}
    this.hello = null; // {extensionId, manifestVersion, at}
    this.lastSeen = 0;
    this.requests = 0;
  }

  get connected() {
    return Boolean(this.hello) && Date.now() - this.lastSeen < 90_000;
  }

  async ready() {
    return this.connected;
  }

  async start() {
    if (this.server) return this;
    this.server = http.createServer((req, res) => this._route(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      // Explicit 127.0.0.1: never bind a routable interface.
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    // Only publish the key once the port is ours: a failed bind must not
    // overwrite the config a live bridge is already using.
    this.writeExtensionConfig();
    return this;
  }

  writeExtensionConfig() {
    const file = path.join(this.extensionDir, "bridge-config.json");
    fs.mkdirSync(this.extensionDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port: this.port, key: this.key }, null, 2) + "\n");
    return file;
  }

  async stop() {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Rejected("bridge shutting down"));
    }
    this.waiters.clear();
    if (this.held) {
      try { this.held.res.writeHead(200, { "content-type": "application/json" }); } catch {}
      try { this.held.res.end(JSON.stringify({ request: null, shutdown: true })); } catch {}
      this.held = null;
    }
    if (this.server) await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  _authorized(req) {
    const given = req.headers["x-ab-key"];
    return typeof given === "string" && timingSafeEqual(given, this.key);
  }

  async _body(req) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8_000_000) throw new Error("body too large");
    }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("body is not JSON"); }
  }

  async _route(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const send = (code, obj) => {
      try {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      } catch {}
    };

    try {
      if (url.pathname === "/status") return send(200, this.status());

      if (!this._authorized(req)) return send(401, { ok: false, error: "bad x-ab-key" });

      if (url.pathname === "/extension/hello" && req.method === "POST") {
        const body = await this._body(req);
        this.hello = { ...body, at: Date.now() };
        this.lastSeen = Date.now();
        return send(200, { ok: true });
      }

      if (url.pathname === "/extension/poll") {
        this.lastSeen = Date.now();
        // One waiting poll at a time; a newer one replaces the stale holder.
        if (this.held) {
          try { this.held.res.writeHead(200, { "content-type": "application/json" }); } catch {}
          try { this.held.res.end(JSON.stringify({ request: null, replaced: true })); } catch {}
        }
        const holdMs = Math.min(Number(url.searchParams.get("hold")) || DEFAULT_POLL_HOLD_MS, 25_000);
        const holder = { res, timer: null };
        this.held = holder;
        holder.timer = setTimeout(() => {
          if (this.held === holder) this.held = null;
          send(200, { request: null, hello: !this.hello });
        }, holdMs);
        this._drain();
        return;
      }

      if (url.pathname === "/agent/request" && req.method === "POST") {
        const { timeoutMs, ...payload } = await this._body(req);
        const type = payload.type;
        const allowed = [
          "cookies", "setCookies", "removeCookies", "ping",
          "tabOpen", "tabInfo", "tabClose", "opRun",
          "extList", "extDetail", "extEnable", "extReload", "extUninstall", "extLoad",
        ];
        if (!allowed.includes(type)) {
          return send(400, { ok: false, error: `unsupported type ${type}` });
        }
        try {
          const data = type === "cookies"
            ? { cookies: await this.cookies(payload.domains || []) }
            : await this.request(payload, { timeoutMs });
          return send(200, { ok: true, data });
        } catch (e) {
          return send(200, { ok: false, error: String(e.message || e).slice(0, 300) });
        }
      }

      if (url.pathname === "/extension/result" && req.method === "POST") {
        const body = await this._body(req);
        const waiter = this.waiters.get(body._rid ?? body.id);
        if (!waiter) return send(200, { ok: false, error: `unknown request id ${body._rid ?? body.id}` });
        clearTimeout(waiter.timer);
        this.waiters.delete(body._rid ?? body.id);
        waiter.resolve(body);
        return send(200, { ok: true });
      }

      return send(404, { ok: false, error: "no such route" });
    } catch (e) {
      return send(500, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }

  _drain() {
    if (!this.held || !this.queue.length) return;
    const holder = this.held;
    this.held = null;
    clearTimeout(holder.timer);
    const request = this.queue.shift();
    try {
      holder.res.writeHead(200, { "content-type": "application/json" });
      holder.res.end(JSON.stringify({ request, hello: !this.hello }));
    } catch {
      // Poll died mid-flight; the request is already removed from the queue and
      // its waiter will time out, which the caller sees as a clear rejection.
    }
  }

  status() {
    return {
      listening: Boolean(this.server),
      port: this.port,
      connected: this.connected,
      extensionId: this.hello?.extensionId || null,
      manifestVersion: this.hello?.manifestVersion || null,
      lastSeen: this.lastSeen ? new Date(this.lastSeen).toISOString() : null,
      requests: this.requests,
      waiting: this.waiters.size,
      borrowedSites: borrowedSites(),
    };
  }

  async request(payload, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (!this.server) throw new Rejected("bridge is not started");
    if (!this.connected) {
      throw new Rejected(
        `no extension connected (status: ${JSON.stringify(this.status())}). ` +
          `Load ${this.extensionDir} as an unpacked extension in chrome://extensions.`
      );
    }
    // `_rid` not `id`: payloads legitimately carry an `id` of their own (the
    // extension-management requests do), and spreading payload over an `id`
    // envelope made the reply come back addressed to a request nobody waits on.
    // `id` is still SENT alongside — a worker loaded before the rename reads
    // request.id and replies {id:...}, which the result route resolves via
    // `body._rid ?? body.id`. Without it every request to such a worker times
    // out while its poll looks perfectly alive (measured on the real machine).
    const rid = `r${++this.seq}`;
    const { id: _businessId, ...rest } = payload;
    const request = { _rid: rid, id: rid, ...rest };
    this.requests += 1;

    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(rid);
        reject(new Rejected(`extension did not answer ${payload.type} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.set(rid, { resolve, reject, timer });
    });

    this.queue.push(request);
    this._drain();

    const out = await reply;
    this.queue = this.queue.filter((r) => r._rid !== rid);
    if (out.ok === false) throw new Rejected(out.error || "extension reported failure");
    return out.data;
  }

  async cookies(domains, options = {}) {
    const data = await this.request({ type: "cookies", domains }, options);
    return data.cookies || [];
  }

  async setCookies(cookies, options = {}) {
    return this.request({ type: "setCookies", cookies }, options);
  }

  // Only for cookies this project wrote; it cannot target anything else.
  async removeCookies(cookies, options = {}) {
    return this.request({ type: "removeCookies", cookies }, options);
  }

  async openTab(payload, options = {}) {
    return this.request({ type: "tabOpen", ...payload }, { timeoutMs: 20000, ...options });
  }

  async tabInfo(tabId, options = {}) {
    return this.request({ type: "tabInfo", tabId }, { timeoutMs: 15000, ...options });
  }

  async runOp(payload, options = {}) {
    return this.request({ type: "opRun", ...payload }, { timeoutMs: 20000, ...options });
  }

  async closeTab(tabId, options = {}) {
    return this.request({ type: "tabClose", tabId }, { timeoutMs: 15000, ...options });
  }

  async ping(options = {}) {
    return this.request({ type: "ping" }, { timeoutMs: 8000, ...options });
  }

  // Extension management: one entry point, the payload carries the operation.
  async ext(payload, options = {}) {
    return this.request(payload, { timeoutMs: 30000, ...options });
  }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readExtensionConfig(extensionDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(extensionDir, "bridge-config.json"), "utf8"));
    return { port: cfg.port, key: cfg.key };
  } catch {
    return null;
  }
}

// Drives a bridge hosted by another process (the MCP server, or a running task).
class BridgeClient {
  constructor({ port, key, extensionDir }) {
    this.port = port;
    this.key = key;
    this.extensionDir = extensionDir;
  }

  async _call(pathname, body) {
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: this.port, path: pathname, method: body ? "POST" : "GET",
          headers: { "x-ab-key": this.key, "content-type": "application/json" }, timeout: 60000 },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({ ok: false, error: "bad json from bridge" }); } });
        }
      );
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "bridge timed out" }); });
      req.on("error", (e) => resolve({ ok: false, error: e.code === "ECONNREFUSED" ? "no bridge is running" : e.message }));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async status() {
    return (await this._call("/status")) || { listening: false };
  }

  get connected() {
    // Sync getter parity with the host: refresh happens in status().
    return Boolean(this._connected);
  }

  async isConnected() {
    const s = await this.status();
    this._connected = Boolean(s?.connected);
    return this._connected;
  }

  async ready() {
    return this.isConnected();
  }

  async cookies(domains, options = {}) {
    const r = await this._call("/agent/request", { type: "cookies", domains, ...options });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data.cookies || [];
  }

  async setCookies(cookies, options = {}) {
    const r = await this._call("/agent/request", { type: "setCookies", cookies, ...options });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async removeCookies(cookies, options = {}) {
    const r = await this._call("/agent/request", { type: "removeCookies", cookies, ...options });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async openTab(payload) {
    const r = await this._call("/agent/request", { type: "tabOpen", ...payload });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async tabInfo(tabId) {
    const r = await this._call("/agent/request", { type: "tabInfo", tabId });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async runOp(payload) {
    const r = await this._call("/agent/request", { type: "opRun", ...payload });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async closeTab(tabId) {
    const r = await this._call("/agent/request", { type: "tabClose", tabId });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async ping() {
    const r = await this._call("/agent/request", { type: "ping" });
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async ext(payload) {
    const r = await this._call("/agent/request", payload);
    if (r.ok === false) throw new Rejected(r.error);
    return r.data;
  }

  async stop() {}
}

// Host if the port is free, otherwise talk to whoever owns it. Only one process
// can hold the extension's long-poll, and it must not be the one that dies first.
export async function createIdentityBridge({ port = 8791, extensionDir = EXT_DIR } = {}) {
  const host = new IdentityBridge({ port, extensionDir });
  try {
    await host.start();
    host.hosting = true;
    return host;
  } catch (e) {
    await host.stop().catch(() => {});
    if (e.code !== "EADDRINUSE") throw e;
  }
  const cfg = readExtensionConfig(extensionDir);
  if (!cfg) throw new Rejected(`port ${port} is taken and no bridge-config.json in ${extensionDir}`);
  const client = new BridgeClient({ ...cfg, port: cfg.port || port, extensionDir });
  client.hosting = false;
  return client;
}
