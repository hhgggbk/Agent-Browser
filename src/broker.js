// Broker: one task = capture -> restore -> run -> write back -> wipe.
//
// The agent supplies a task function that receives the AgentBrowser instance.
// Everything before and after it is identity plumbing.

import fs from "node:fs";
import path from "node:path";
import { captureIdentity, listLoggedInOrigins, probePort, CHROME_EXE } from "./capture.js";
import { IdentityVault } from "./vault.js";
import { AgentBrowser } from "./agent-browser.js";
import { writeBack, writeBackViaBridge } from "./writeback.js";
import { createIdentityBridge } from "./bridge.js";
import { acquireSiteLock, releaseSiteLock } from "./site-lock.js";

function debugLog(...args) {
  if (process.env.AGENT_BROWSER_DEBUG) console.error("[broker]", ...args);
}

export function loadConfig(file) {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const p = file || path.join(here, "..", "config", "default.json");
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  return cfg;
}

export class Broker {
  constructor(config = {}) {
    this.config = { ...loadConfig(), ...config };
    this.vault = new IdentityVault({ ttlMs: (this.config.agent?.profileTtlMinutes || 60) * 60000 });
    this.userCookies = [];
    this.agent = null;
  }

  // Whether identity capture is allowed at all. Off by default: a published
  // runtime must not read the user's cookies unless they said yes.
  get captureEnabled() {
    return this.config.capture?.enabled === true;
  }

  async listOrigins() {
    if (!this.captureEnabled) {
      return { skipped: true, reason: "capture.enabled=false — 不读取你浏览器里的任何身份", origins: [] };
    }
    return listLoggedInOrigins({ port: this.config.port });
  }

  // Capture the user's identity into the vault. Fails loudly when no usable
  // identity exists: running the task against an anonymous agent browser would
  // look like success while silently doing the wrong thing.
  async capture(scope = "default") {
    if (!this.captureEnabled) {
      this.captureSkipped = true;
      debugLog("capture disabled (capture.enabled=false) — agent runs anonymous");
      return { skipped: true, mode: "disabled", cookies: [], storages: [] };
    }
    const hosts = this.config.whitelist?.hosts || [];
    if (hosts.length === 0) throw new Error("whitelist.hosts is empty — nothing to capture");
    const bridge = await this.ensureBridge();
    const result = await captureIdentity({
      port: this.config.port,
      hosts,
      origins: hosts.map((h) => `https://${h.replace(/^\./, "")}`),
      bridge,
      captureLocalStorage: this.config.whitelist?.captureLocalStorage !== false,
    });
    if (result.usable === false) {
      throw new Error(
        `cannot capture usable identity: ${result.reason}\n` +
          `on-disk cookie names: ${result.disk?.map((d) => d.name).slice(0, 12).join(", ") || "(none)"}\n` +
          `fix: load cookie-extension/ as an unpacked extension in chrome://extensions, ` +
          `or start Chrome with --remote-debugging-port=${this.config.port} on a non-default --user-data-dir`,
      );
    }
    this.captureMode = result.mode;
    this.userCookies = result.cookies;
    this.vault.put(scope, { cookies: result.cookies, storages: result.storages || [] });
    return result;
  }

  // The bridge is shared: if another process already owns the port we talk to
  // it as a client, so an MCP server and a task run do not fight over it.
  async ensureBridge() {
    if (!this.captureEnabled) return null;
    if (this.config.bridge?.enabled === false) return null;
    if (this.bridge) return this.bridge;
    try {
      this.bridge = await createIdentityBridge({
        port: this.config.bridge?.port || 8791,
      });
      this.hostsBridge = Boolean(this.bridge.hosting);
      return this.bridge;
    } catch (e) {
      debugLog("bridge unavailable:", e.message);
      return null;
    }
  }

  async startAgent({ headless, silent, scope = "default", ignoreHTTPSErrors = false } = {}) {
    const h = headless ?? silent ?? this.config.agent?.silent ?? false;
    const cdp = this.config.cdp || {};
    const cdpPort = cdp.enabled ? Number(cdp.port || 9333) : null;
    this.agent = new AgentBrowser({
      scope,
      headless: h,
      ignoreHTTPSErrors,
      extraArgs: this.config.agent?.extraChromeArgs || [],
      guard: this.config.guard,
      extensions: this.config.agent?.extensions || [],
      cdpPort,
    });
    await this.agent.start();
    return this.agent;
  }

  async restore(scope = "default", hosts) {
    const hs = hosts ?? this.config.whitelist?.hosts ?? [];
    const cookies = this.vault.cookiesFor(scope, hs);
    const n = await this.agent.restoreCookies(cookies);
    for (const h of hs) {
      const st = this.vault.storageFor(scope, `https://${h.replace(/^\./, "")}`);
      if (st && !st.error) {
        await this.agent.restoreStorage(st.origin, st);
      }
    }
    return { cookiesRestored: n };
  }

  async finish({ scope = "default", confirm } = {}) {
    if (!this.captureEnabled || this.captureSkipped) {
      return {
        written: 0, skipped: 0, items: [], summary: [], disabled: true,
        reason: "capture.enabled=false — 本次没有借用你的身份，也没有东西需要写回",
      };
    }
    const agentCookies = await this.agent.currentCookies();
    const wb = this.config.writeback || {};
    if (!wb.enabled) {
      return { written: 0, skipped: 0, items: [], summary: [], disabled: true };
    }
    const c = confirm ?? wb.confirm ?? true;

    if (await probePort(this.config.port)) {
      return writeBack({
        port: this.config.port,
        userCookies: this.userCookies,
        agentCookies,
        confirm: c,
      });
    }
    const bridge = await this.ensureBridge();
    if (bridge && (await bridge.ready())) {
      return writeBackViaBridge({
        bridge,
        userCookies: this.userCookies,
        agentCookies,
        confirm: c,
      });
    }
    // No route to the user's browser. Say so instead of reporting a write that
    // never happened.
    return {
      written: 0,
      skipped: agentCookies.length,
      items: [],
      summary: [],
      refused: `no CDP port on 127.0.0.1:${this.config.port} and no extension bridge connected — nothing was written back`,
    };
  }

  async close() {
    await this.agent?.close();
    if (this.hostsBridge) await this.bridge?.stop().catch(() => {});
    this.bridge = null;
    this.vault.clear();
  }
}

// Run a full task. taskFn receives (agentBrowser, broker).
// options.hosts: cookie domains to capture and restore (e.g. ["github.com"]).
export async function runTask(taskFn, options = {}) {
  const config = { ...(options.config || {}) };
  if (options.hosts?.length) {
    config.whitelist = { ...(config.whitelist || {}), hosts: options.hosts };
  }
  if (options.extensions?.length) {
    config.agent = { ...(config.agent || {}), extensions: options.extensions };
  }
  // Session exclusivity: one borrower per site. The lock cannot see the user's
  // own browsing — it keeps two agent sessions off the same account at once.
  const lock = acquireSiteLock(config.whitelist?.hosts || [], { task: "runTask" });
  if (!lock.ok) {
    const c = lock.conflicts[0];
    return {
      ok: false,
      error:
        `site ${c.host} is already borrowed by another agent session ` +
        `(pid ${c.holder.pid}, "${c.holder.task}", since ${new Date(c.holder.at).toISOString()}). ` +
        `one borrower at a time: wait for it to finish, or stop that task.`,
      borrowed: lock.conflicts,
    };
  }
  const broker = new Broker(config);
  let writeback = null;
  const violations = () => broker.agent?.guardViolations || [];
  try {
    await broker.capture(options.scope || "default");
    const agent = await broker.startAgent({
      headless: options.headless,
      silent: options.silent,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors,
    });
    await broker.restore(options.scope || "default", options.hosts);
    await taskFn(agent, broker);
    writeback = await broker.finish({
      scope: options.scope || "default",
      confirm: options.confirm,
    });
    return {
      ok: true,
      writeback,
      // Anonymous = the agent never got your session. Reported explicitly so a
      // caller can never mistake a disabled run for a borrowed-identity run.
      anonymous: !broker.captureEnabled || broker.captureSkipped,
      cdpUrl: agent.cdpUrl || null,
      guardViolations: violations(),
    };
  } catch (e) {
    return { ok: false, error: e.message, writeback, guardViolations: violations() };
  } finally {
    releaseSiteLock(lock.token);
    await broker.close();
  }
}

if (process.argv[1]?.endsWith("broker.js")) {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    const b = new Broker();
    const out = await b.listOrigins();
    console.log(JSON.stringify(out, null, 2));
  }
}
