// Drive pages INSIDE the user's own browser, through the extension bridge.
//
// This is the alternative to launching a second browser: no new instance, so
// risk control sees one environment, and the credentials are already there.
// The cost is that a tab appears in his window, so everything here is
// deliberate: tabs are opened inactive, only the extension's own tabs are ever
// reachable, and every call re-checks the path-level禁区 before it touches the
// page.
//
// Nothing in this file talks to Chrome directly. Chrome executes it from inside
// the loaded extension (cookie-extension/background.js), which means the only
// operations available are the fixed menu there — no arbitrary code injection.

import { assertGuard, findViolation, guardFromConfig, GuardViolation } from "./guard.js";

const POLL_MS = 250;

export class UserTabs {
  constructor({ bridge, guard, timeoutMs = 20000 } = {}) {
    if (!bridge) throw new Error("UserTabs needs a connected identity bridge");
    this.bridge = bridge;
    this.guard = guardFromConfig(guard || {});
    this.timeoutMs = timeoutMs;
    this.tabs = new Set();
    this.guardViolations = [];
  }

  async connect({ timeoutMs = 45000 } = {}) {
    // The worker may still be booting: it announces itself as soon as it runs,
    // so waiting is the whole trick. One snapshot here would race the browser.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.bridge.ready()) return this;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(
      `no extension is answering the bridge after ${timeoutMs}ms, so there is no browser to open a page in. ` +
        `Load cookie-extension/ as an unpacked extension in chrome://extensions. status=${JSON.stringify(
          await Promise.resolve(this.bridge.status()).catch(() => null),
        )}`,
    );
  }

  // Opens a background tab and waits until Chrome reports it complete.
  async open(url, { active = false, window = false } = {}) {
    assertGuard(url, this.guard);
    const opened = await this.bridge.openTab({ url, active, window });
    this.tabs.add(opened.tabId);
    const deadline = Date.now() + this.timeoutMs;
    let info = opened;
    while (Date.now() < deadline) {
      info = await this.bridge.tabInfo(opened.tabId);
      if (info.status === "complete") break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    try {
      assertGuard(info.url, this.guard);
    } catch (e) {
      await this.close(opened.tabId).catch(() => {});
      throw e;
    }
    return { tabId: opened.tabId, url: info.url, title: info.title, windowId: info.windowId };
  }

  // A tab may have navigated itself into a禁区 since we opened it. Check the
  // live URL before every operation, and close the page rather than read it.
  async _checked(tabId) {
    const info = await this.bridge.tabInfo(tabId);
    const found = this.guard.enabled === false ? null : findViolation(info.url, this.guard);
    if (found) {
      this.guardViolations.push({ url: found.url, rule: found.rule.path, category: found.rule.category, tabId, at: Date.now() });
      await this.close(tabId).catch(() => {});
      throw new GuardViolation(found);
    }
    return info;
  }

  async run(tabId, op, args = []) {
    await this._checked(tabId);
    const r = await this.bridge.runOp({ tabId, op, args });
    return r.value;
  }

  state(tabId) { return this.run(tabId, "state"); }
  title(tabId) { return this.run(tabId, "title"); }
  text(tabId, sel) { return this.run(tabId, "text", [sel]); }
  html(tabId, sel) { return this.run(tabId, "html", [sel]); }
  attr(tabId, sel, name) { return this.run(tabId, "attr", [sel, name]); }
  exists(tabId, sel) { return this.run(tabId, "exists", [sel]); }
  count(tabId, sel) { return this.run(tabId, "count", [sel]); }
  meta(tabId, name) { return this.run(tabId, "meta", [name]); }
  links(tabId, limit) { return this.run(tabId, "links", [limit]); }
  inputs(tabId) { return this.run(tabId, "inputs"); }
  click(tabId, sel) { return this.run(tabId, "click", [sel]); }
  clickIndex(tabId, i) { return this.run(tabId, "clickIndex", [i]); }
  fill(tabId, sel, value) { return this.run(tabId, "fill", [sel, String(value)]); }
  press(tabId, sel, key) { return this.run(tabId, "press", [sel, key]); }

  // Waits for an operation to return a truthy value; the menu has no events, so
  // polling is how late-rendered content gets caught.
  async waitFor(tabId, op, args = [], { timeoutMs = 10000, intervalMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.run(tabId, op, args);
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${op}(${args.join(",")}) on tab ${tabId}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async close(tabId) {
    const r = await this.bridge.closeTab(tabId);
    this.tabs.delete(Number(tabId));
    return r;
  }

  async closeAll() {
    const closed = [];
    for (const id of [...this.tabs]) {
      // One tab dying under us must not strand the rest.
      await this.close(id).then(() => closed.push(id)).catch(() => this.tabs.delete(id));
    }
    return closed;
  }
}
