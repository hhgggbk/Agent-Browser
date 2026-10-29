// Agent browser: a Chromium the agent drives, isolated from the user's.
//
// Identity is restored into an ephemeral profile directory per task, then deleted
// on close. Nothing the agent does touches the user's profile.

import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHROME_EXE } from "./capture.js";
import { assertGuard, findViolation, guardFromConfig, GuardViolation } from "./guard.js";

function debugLog(...args) {
  if (process.env.AGENT_BROWSER_DEBUG) console.error("[agent-browser]", ...args);
}

// UA 改写：HeadlessChrome 是自动化铁证。用当前 Chrome 真实版本号拼 headed UA。
// 注意 UA 里的 Chrome 主版本必须和实际内核一致，否则反而更可疑。
// Windows 上进程无窗口由 launch 的 windowsHide 承担，见 start()。
function headedUserAgent(headless) {
  if (!headless) return undefined;
  const m = process.versions.chrome;
  const major = m ? m.split(".")[0] : "155";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function launchOptions({ executablePath = CHROME_EXE, userDataDir, headless = true, extraArgs = [], ignoreHTTPSErrors = false, userAgent, ignoreDefaultArgs = ["--enable-automation"], timeout = 30000, cdpPort = null }) {
  return {
    executablePath,
    headless,
    ignoreHTTPSErrors,
    ...(userAgent ? { userAgent } : {}),
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--disable-background-networking",
      "--disable-component-update",
      "--metrics-recording-only",
      "--no-service-autostart",
      "--password-store=basic",
      "--use-mock-keychain",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      // Blink 的 automation 开关：driven by CDP 会让 navigator.webdriver 变 true，
      // 并改变若干 API 行为。这是 headless 下最重要的一个开关。
      "--disable-blink-features=AutomationControlled",
      ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
      // 这个参数能用是因为 agent 用的永远是临时/自有 profile：Chrome 136+ 拒绝的
      // 是「默认 profile 上开调试端口」。
      ...extraArgs,
    ],
    // Keep the agent's storage fully inside its own profile so nothing lands in
    // the user's AppData.
    userDataDir,
    ignoreDefaultArgs,
    timeout,
  };
}

// 在页面上下文里抹掉 JS 层能探到的自动化痕迹。CDP init script 在每个文档
// （含 iframe）加载前执行，所以改的是真实值而不是被覆盖后再擦。
const STEALTH_INIT = () => {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  } catch {}
  try {
    // 无头 Chromium 的 plugins 长度为 0 是常见检测点；headed 通常 3-5 个。
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `p${i}`, description: "", filename: `p${i}` })),
    });
  } catch {}
  try {
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
  } catch {}
};

export class AgentBrowser {
  constructor({ scope = "default", headless = true, executablePath, extraArgs = [], ignoreHTTPSErrors = false, guard, extensions = [], profileDir = null, launchTimeout = 30000, cdpPort = null } = {}) {
    this.scope = scope;
    this.headless = headless;
    this.cdpPort = cdpPort;
    this.executablePath = executablePath;
    this.extraArgs = extraArgs;
    this.ignoreHTTPSErrors = ignoreHTTPSErrors;
    this.guard = guardFromConfig(guard || {});
    this.guardViolations = [];
    // Unpacked extension dirs. Installed over CDP only: measured on this Chrome,
    // --load-extension is ignored whether or not the documented feature flags are
    // passed, and having it in the command line breaks the CDP install too.
    this.extensions = extensions.map((p) => ({ path: p, id: null, error: null }));
    // A profile the caller owns: never created here, never deleted here.
    this.profileDir = profileDir ? path.resolve(profileDir) : null;
    this.ephemeral = !profileDir;
    this.launchTimeout = launchTimeout;
    this.userDataDir = null;
    this.context = null;
    this.browser = null;
    this._closed = false;
  }

  async start() {
    this.userDataDir = this.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), `ab-agent-${process.pid}-`));
    debugLog("profile", this.userDataDir, this.ephemeral ? "(temp)" : "(caller's own profile)");
    this.browser = await chromium.launchPersistentContext(this.userDataDir, launchOptions({
      userDataDir: this.userDataDir,
      headless: this.headless,
      executablePath: this.executablePath,
      extraArgs: this.extraArgs,
      ignoreHTTPSErrors: this.ignoreHTTPSErrors,
      userAgent: headedUserAgent(this.headless),
      timeout: this.launchTimeout,
      cdpPort: this.cdpPort,
      // Measured: Playwright passes --disable-extensions by default, so a
      // CDP-loaded extension registers but stays inert. Only strip it when this
      // browser asked for extensions, so the normal fingerprint is untouched.
      ignoreDefaultArgs: this.extensions.length
        ? ["--enable-automation", "--disable-extensions"]
        : ["--enable-automation"],
    }));
    this.context = this.browser;
    this.cdpUrl = this.cdpPort ? `http://127.0.0.1:${this.cdpPort}` : null;
    // Runs before any page script, on every document including iframes.
    await this.context.addInitScript(STEALTH_INIT);
    for (const ext of this.extensions) await this.loadExtension(ext.path);
    const failed = this.extensions.filter((e) => e.error);
    if (failed.length) {
      throw new Error(`extension load failed:\n${failed.map((e) => `  ${e.path}: ${e.error}`).join("\n")}`);
    }
    return this;
  }

  // Returns the extension id Chrome assigned. Loading the same path twice
  // restarts it, so callers keep the id from the first load.
  async loadExtension(dir) {
    const entry = this.extensions.find((e) => e.path === dir);
    const abs = path.resolve(dir);
    if (!fs.existsSync(path.join(abs, "manifest.json"))) {
      const msg = `no manifest.json in ${abs}`;
      if (entry) entry.error = msg;
      throw new Error(msg);
    }
    const browser = this.context.browser?.() || null;
    if (!browser || typeof browser.newBrowserCDPSession !== "function") {
      const msg = "browser-level CDP session unavailable, cannot load extensions";
      if (entry) entry.error = msg;
      throw new Error(msg);
    }
    let id = null, err = null;
    try {
      const sess = await browser.newBrowserCDPSession();
      // Forward slashes: Chrome rejects mixed Windows separators in this param.
      const r = await sess.send("Extensions.loadUnpacked", { path: abs.replace(/\\/g, "/") });
      id = r?.id || null;
      if (!id) err = `Extensions.loadUnpacked returned ${JSON.stringify(r)}`;
    } catch (e) {
      err = e.message;
    }
    if (entry) { entry.id = id; entry.error = err; }
    if (err) throw new Error(`loadUnpacked ${abs}: ${err}`);
    debugLog("extension loaded", id, abs);
    return id;
  }

  // Every page the task touches goes through here, so no navigation escapes
  // the watcher — including the internal ones used to seed storage.
  async _newPage() {
    const p = await this.context.newPage();
    this._watchGuard(p);
    return p;
  }

  // In-page navigation (link, SPA route, JS redirect) never passes through
  // page(), so it is caught after the fact: the page is closed and the event is
  // recorded. Closing is the only reliable answer — by the time this fires the
  // document has already loaded, and a token page may have minted a secret.
  _watchGuard(page) {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      if (this.guard.enabled === false) return;
      let found = null;
      try {
        found = findViolation(page.url(), this.guard);
      } catch (e) {
        debugLog("guard check failed", e.message);
      }
      if (!found) return;
      this.guardViolations.push({ url: found.url, rule: found.rule.path, category: found.rule.category, at: Date.now() });
      debugLog("guard violation", found.rule.path, found.url);
      page.close().catch(() => {});
    });
  }

  async page(url, opts = {}) {
    const p = await this._newPage();
    if (url) {
      assertGuard(url, this.guard);
      try {
        await p.goto(url, { waitUntil: "domcontentloaded", ...opts });
      } catch (e) {
        // The watcher closes the page the moment a redirect commits into a
        //禁区, so goto can fail with "page closed" instead of a guard message.
        const blocked = this.guard.enabled !== false && findViolation(p.url(), this.guard);
        await p.close().catch(() => {});
        if (blocked) throw new GuardViolation(blocked);
        throw e;
      }
      // The site may have redirected into a禁区. Re-check the URL we actually
      // landed on, and do not hand back a page that is sitting in it.
      try {
        assertGuard(p.url(), this.guard);
      } catch (e) {
        await p.close().catch(() => {});
        throw e;
      }
    }
    return p;
  }

  // Restore cookies captured from the user's browser into the agent profile.
  async restoreCookies(cookies) {
    if (!cookies?.length) return 0;
    await this.context.addCookies(
      cookies.map((c) => {
        const out = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        };
        // Bridge session cookies arrive as expires:null, which Playwright reads
        // as "got object"; CDP's are 0. Only a real timestamp is carried over.
        if (typeof c.expires === "number" && isFinite(c.expires) && c.expires > 0) out.expires = c.expires;
        if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") out.sameSite = c.sameSite;
        if (c.partitionKey) out.partitionKey = c.partitionKey;
        return out;
      })
    );
    return cookies.length;
  }

  async restoreStorage(origin, { localStorage = {}, sessionStorage = {} }) {
    if (!Object.keys(localStorage).length && !Object.keys(sessionStorage).length) return;
    const page = await this._newPage();
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.evaluate(({ ls, ss }) => {
        for (const [k, v] of Object.entries(ls)) {
          try { window.localStorage.setItem(k, v); } catch {}
        }
        for (const [k, v] of Object.entries(ss)) {
          try { window.sessionStorage.setItem(k, v); } catch {}
        }
      }, { ls: localStorage, ss: sessionStorage });
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Every cookie the agent's browser currently holds — the write-back diff is
  // computed by the caller against the user's original set.
  async currentCookies() {
    return this.context.cookies();
  }

  async evaluate(script, arg) {
    const page = await this._newPage();
    try {
      return await page.evaluate(script, arg);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    await this.browser?.close().catch(() => {});
    // Kill the browser process tree, then wipe the profile.
    if (this.context) {
      try { await this.context.close(); } catch {}
    }
    if (this.userDataDir && this.ephemeral) {
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        debugLog("profile cleanup failed", e.message);
      }
    }
  }
}
