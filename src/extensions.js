// Extension management in the browser the user is actually running.
//
// Channel: the loaded cookie-extension, which holds chrome.management. That is
// the only path that reaches the browser's extension list without taking over
// the screen — chrome://extensions is not scriptable from outside (no debugging
// port on the default profile), and driving its buttons by pixel is what we
// stopped doing.
//
// What works and what cannot, measured (2026-10-20):
//   list / detail / enable / disable / reload / uninstall   yes, via management
//   load an unpacked folder                                  only when
//     chrome.developerPrivate is reachable; otherwise this module refuses with an
//     explanation instead of pretending. For the agent's OWN browser,
//     AgentBrowser.loadExtension() (CDP Extensions.loadUnpacked) covers it.
//
// Safety rails that are not the caller's job:
//   * the bridge cannot disable or uninstall itself (the reply would die with it);
//   * uninstall/reload changes are confirmed by re-listing, so "requested" never
//     reads as "done".

export class ExtensionManager {
  constructor(bridge) {
    if (!bridge) throw new Error("ExtensionManager needs a connected identity bridge");
    this.bridge = bridge;
  }

  async _ready() {
    if (typeof this.bridge.ready === "function") await this.bridge.ready();
    return this.bridge;
  }

  async list() {
    await this._ready();
    const out = await this.bridge.ext({ type: "extList" });
    return out.extensions || [];
  }

  // A shorthand for scripts: find by id, or by exact/partial name.
  async find(query) {
    const all = await this.list();
    const q = String(query || "").trim();
    if (!q) throw new Error("find() needs an id or a name");
    const byId = all.find((x) => x.id === q);
    if (byId) return byId;
    const exact = all.find((x) => x.name === q);
    if (exact) return exact;
    const partial = all.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`"${q}" matches ${partial.length} extensions: ${partial.map((x) => `${x.name} (${x.id})`).join(", ")}`);
    }
    throw new Error(`no extension matches "${q}"`);
  }

  async detail(query) {
    const x = await this.find(query);
    await this._ready();
    return this.bridge.ext({ type: "extDetail", targetId: x.id });
  }

  async setEnabled(query, enabled) {
    const x = await this.find(query);
    await this._ready();
    return this.bridge.ext({ type: "extEnable", targetId: x.id, enabled: Boolean(enabled) });
  }

  // Reload re-reads the unpacked folder. Note the Chrome 155 trap: a reload of a
  // hand-loaded extension can leave it permanently disabled; the extension's own
  // management.reload goes through the same path, so the caller decides.
  async reload(query) {
    const x = await this.find(query);
    await this._ready();
    return this.bridge.ext({ type: "extReload", targetId: x.id });
  }

  // Removal is real only if a fresh list says so. Chrome may instead refuse and
  // require the user's own confirmation; that is reported, not hidden.
  async uninstall(query) {
    const x = await this.find(query);
    await this._ready();
    const res = await this.bridge.ext({ type: "extUninstall", targetId: x.id });
    const stillThere = (await this.list().catch(() => [])).some((e) => e.id === x.id);
    return { ...res, gone: !stillThere };
  }

  async loadUnpacked(dir) {
    await this._ready();
    return this.bridge.ext({ type: "extLoad", path: dir });
  }
}
