// MV3 service worker for the Agent Browser identity bridge.
//
// Chrome decrypts cookie values for us, so this path is not subject to the
// 136+ "no debugging port on the default profile" gate and needs no restart.
// The extension only ever talks to 127.0.0.1; there is no remote host in this
// file. Values are forwarded to the local bridge and never logged.
//
// Long-poll keeps the worker alive and gives sub-second latency; the alarm is
// the resurrection net for when Chrome reaps the worker anyway.

const DEFAULT_PORT = 8791;
const POLL_HOLD_MS = 20000; // must stay under Chrome's ~30s idle worker kill
const ALARM = "ab-bridge-keepalive";

let key = null;
let base = null;
let requests = 0;

async function loadConfig() {
  if (base) return { base, key };
  try {
    const r = await fetch(chrome.runtime.getURL("bridge-config.json"));
    const cfg = await r.json();
    base = `http://127.0.0.1:${cfg.port || DEFAULT_PORT}`;
    key = cfg.key;
  } catch {
    base = `http://127.0.0.1:${DEFAULT_PORT}`;
  }
  return { base, key };
}

async function call(pathname, options = {}) {
  const { base: b, key: k } = await loadConfig();
  const headers = { "content-type": "application/json" };
  if (k) headers["x-ab-key"] = k;
  const res = await fetch(b + pathname, { ...options, headers });
  // The bridge writes a new key on every start; a rejection means ours is stale.
  if (res.status === 401 || res.status === 403) {
    base = null;
    key = null;
  }
  return res.json();
}

// chrome.cookies sameSite -> CDP/additive-write vocabulary.
function sameSiteOut(v) {
  if (v === "no_restriction") return "None";
  if (v === "strict") return "Strict";
  if (v === "lax") return "Lax";
  return "Lax";
}
function sameSiteIn(v) {
  const s = String(v || "").toLowerCase();
  if (s === "none" || s === "no_restriction") return "no_restriction";
  if (s === "strict") return "strict";
  return "lax";
}

async function readCookies(domains) {
  const out = [];
  const seen = new Set();
  for (const raw of domains || []) {
    const domain = String(raw).replace(/^\./, "").replace(/:\d+$/, "");
    if (!domain) continue;
    const jar = await chrome.cookies.getAll({ domain });
    for (const c of jar) {
      const id = `${c.name}\u0000${c.domain}\u0000${c.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: sameSiteOut(c.sameSite),
        session: !c.expirationDate,
        expires: c.expirationDate || null,
        hostOnly: c.hostOnly,
      });
    }
  }
  return out;
}

async function removeCookies(cookies) {
  const removed = [];
  const missed = [];
  for (const c of cookies || []) {
    const bare = String(c.domain || "").replace(/^\./, "");
    if (!bare) { missed.push({ name: c.name, reason: "no domain" }); continue; }
    const url = `https://${bare}${c.path || "/"}`;
    try {
      const r = await chrome.cookies.remove({ url, name: c.name });
      if (r) removed.push(c.name);
      else missed.push({ name: c.name, reason: "not found" });
    } catch (e) {
      missed.push({ name: c.name, reason: String(e.message || e).slice(0, 100) });
    }
  }
  return { removed, missed };
}

async function applyCookies(cookies) {
  const applied = [];
  const failed = [];
  for (const c of cookies || []) {
    const bare = String(c.domain || "").replace(/^\./, "");
    if (!bare) {
      failed.push({ name: c.name, reason: "no domain" });
      continue;
    }
    // chrome.cookies.set keys off a URL, not a domain. Trust the cookie's own
    // `secure` flag; if the https set fails (plain-http site) retry over http.
    const urls = [`https://${bare}${c.path || "/"}`];
    if (c.secure !== true) urls.push(`http://${bare}${c.path || "/"}`);
    // A session cookie arrives as expires:-1 (CDP) or null; either value passed
    // through as expirationDate makes Chrome refuse the write. Only a real
    // future timestamp means "persistent".
    const expires = Number(c.expires);
    const expirationDate = Number.isFinite(expires) && expires > 0 ? expires : undefined;
    let last = null;
    for (const url of urls) {
      try {
        const saved = await chrome.cookies.set({
          url,
          name: c.name,
          value: c.value,
          path: c.path || "/",
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: sameSiteIn(c.sameSite),
          expirationDate,
        });
        // chrome.cookies.set resolves to null when it refuses instead of
        // throwing; counting that as applied is how a write-back reports success
        // while the jar stays empty (measured: expires:-1, applied but absent).
        if (!saved) {
          last = new Error("chrome.cookies.set refused (returned null)");
          continue;
        }
        applied.push(c.name);
        last = null;
        break;
      } catch (e) {
        last = e;
      }
    }
    if (last) failed.push({ name: c.name, reason: String(last.message || last).slice(0, 120) });
  }
  return { applied, failed };
}

// document.querySelector() does not enter shadow roots, and GitHub-class pages
// put their whole form inside one (<react-app>). Walk open roots as well.
// Closed roots stay unreachable — that is a spec limit, not this helper's, so
// those pages still need the CDP/UIA route. NODE_BUDGET keeps a huge page from
// stalling the service worker.
const NODE_BUDGET = 60000;
function deepQueryAll(sel) {
  const out = [];
  const seen = new Set();
  let visited = 0;
  const walk = (root) => {
    if (visited > NODE_BUDGET) return;
    let found;
    try { found = root.querySelectorAll(sel); } catch { return; }
    for (const el of found) {
      if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    for (const host of root.querySelectorAll("*")) {
      if (++visited > NODE_BUDGET) return;
      if (host.shadowRoot) walk(host.shadowRoot);
    }
  };
  walk(document);
  return out;
}
const deepQuery = (sel) => deepQueryAll(sel)[0] || null;

// --- tab driving -----------------------------------------------------------
// MV3 service workers have no eval, so the agent cannot inject arbitrary code:
// it picks from this fixed menu, and Chrome serializes the chosen function into
// the page. That limit is deliberate — it is what keeps "read my logged-in page"
// from becoming "run anything in my logged-in page".
const OPS = {
  state: () => ({ title: document.title, url: location.href, ready: document.readyState }),
  title: () => document.title,
  text: (sel) => {
    const e = deepQuery(sel);
    return e ? (e.textContent || "").slice(0, 20000) : null;
  },
  html: (sel) => {
    const e = deepQuery(sel);
    return e ? e.innerHTML.slice(0, 200000) : null;
  },
  attr: (sel, name) => {
    const e = deepQuery(sel);
    return e ? e.getAttribute(name) : null;
  },
  exists: (sel) => Boolean(deepQuery(sel)),
  count: (sel) => deepQueryAll(sel).length,
  meta: (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? null,
  links: (limit) =>
    Array.from(deepQueryAll("a[href]"))
      .slice(0, limit || 60)
      .map((a) => ({ text: (a.textContent || "").trim().slice(0, 80), href: a.href })),
  inputs: () =>
    Array.from(deepQueryAll("input,textarea,select,button,[role=button],[contenteditable=true]"))
      .slice(0, 200)
      .map((e, i) => ({
        i,
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute("type") || null,
        id: e.id || null,
        name: e.getAttribute("name") || null,
        placeholder: e.getAttribute("placeholder") || null,
        aria: e.getAttribute("aria-label") || null,
        text: (e.textContent || "").trim().slice(0, 60),
        visible: Boolean(e.offsetWidth || e.offsetHeight),
      })),
  click: (sel) => {
    const e = deepQuery(sel);
    if (!e) return false;
    e.click();
    return true;
  },
  clickIndex: (i) => {
    const list = Array.from(deepQueryAll("input,textarea,select,button,[role=button],[contenteditable=true]"));
    const e = list[i];
    if (!e) return false;
    e.click();
    return true;
  },
  // Value + the events frameworks listen for; a bare assignment would leave
  // React/Vue state untouched and the page would act like nothing happened.
  // contenteditable is the exception: rich editors keep their state in an
  // editor model, so the only write that counts is one that goes through the
  // editor's own input handling.
  fill: (sel, value) => {
    const e = deepQuery(sel);
    if (!e) return false;
    const want = String(value);
    if (e.isContentEditable) {
      e.focus();
      const range = document.createRange();
      range.selectNodeContents(e);
      const sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(range);
      let ok = false;
      try {
        // Empty value still needs the delete path, not insertText("").
        if (want === "") ok = document.execCommand("delete", false, null);
        else ok = document.execCommand("insertText", false, want);
      } catch {}
      if (!ok) {
        e.textContent = want;
        e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: want }));
      }
      const got = (e.textContent || "").trim();
      return got === want.trim();
    }
    const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(e, want);
    else e.value = want;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return e.value === want;
  },
  press: (sel, key) => {
    const e = deepQuery(sel);
    if (!e) return false;
    for (const type of ["keydown", "keypress", "keyup"]) {
      e.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
    }
    return true;
  },
};

// Tabs this extension opened. Everything below refuses to touch a tab that is
// not in here, which is what keeps the user's own pages out of reach.
const owned = new Set();

async function markOwned(tabId) {
  owned.add(tabId);
  try {
    const { ownedTabs = [] } = await chrome.storage.session.get("ownedTabs");
    if (!ownedTabs.includes(tabId)) await chrome.storage.session.set({ ownedTabs: [...owned, ...ownedTabs] });
  } catch {}
  return true;
}

async function isOwned(tabId) {
  if (owned.has(tabId)) return true;
  try {
    const { ownedTabs = [] } = await chrome.storage.session.get("ownedTabs");
    ownedTabs.forEach((t) => owned.add(t));
  } catch {}
  return owned.has(tabId);
}

async function openTab({ url, active = false, window = false }) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error(`only http(s) urls, got ${String(url).slice(0, 60)}`);
  const tab = window
    ? await chrome.windows.create({ url, focused: Boolean(active) })
    : await chrome.tabs.create({ url, active: Boolean(active) });
  const t = window ? (await chrome.tabs.get(tab.tabs[0].id)) : tab;
  await markOwned(t.id);
  return { tabId: t.id, url: t.url || url, windowId: t.windowId, active: t.active };
}

async function tabInfo(tabId) {
  if (!(await isOwned(Number(tabId)))) throw new Error(`tab ${tabId} was not opened by this extension`);
  const t = await chrome.tabs.get(Number(tabId));
  return { tabId: t.id, url: t.url, title: t.title, status: t.status, active: t.active, windowId: t.windowId };
}

async function closeTab(tabId) {
  const id = Number(tabId);
  if (!(await isOwned(id))) throw new Error(`tab ${tabId} was not opened by this extension`);
  await chrome.tabs.remove(id);
  owned.delete(id);
  const { ownedTabs = [] } = await chrome.storage.session.get("ownedTabs");
  await chrome.storage.session.set({ ownedTabs: ownedTabs.filter((t) => t !== id) });
  return { closed: id };
}

async function runOp({ tabId, op, args = [] }) {
  const id = Number(tabId);
  if (!Object.hasOwn(OPS, op)) throw new Error(`unknown op ${op}`);
  if (!(await isOwned(id))) throw new Error(`tab ${tabId} was not opened by this extension`);
  const results = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: OPS[op],
    args,
  });
  const value = results?.[0]?.result;
  const t = await chrome.tabs.get(id);
  return { op, value, url: t.url };
}

// --- extension management --------------------------------------------------
// chrome.management is the only channel that reaches the browser's extension
// list from outside Chrome's UI. Two limits are real and stated in the returns:
//   * loadUnpacked needs developerPrivate, which only exists for the dev-mode UI;
//     when it is missing the caller gets a clear error instead of a silent no-op.
//   * uninstalling this very extension would kill the worker mid-reply, so it is
//     refused here.
function shapeInfo(x) {
  return {
    id: x.id,
    name: x.name,
    version: x.version,
    enabled: x.enabled,
    type: x.type,
    installType: x.installType,
    description: x.description ? String(x.description).slice(0, 200) : "",
    mayDisable: x.mayDisable,
    permissions: (x.permissions || []).slice(0, 40),
    hostPermissions: (x.hostPermissions || []).slice(0, 40),
  };
}

async function listExtensions() {
  const all = await chrome.management.getAll();
  return { count: all.length, extensions: all.map(shapeInfo) };
}

// The target id travels as targetId: the bridge owns its envelope fields, and a
// top-level `id` would collide with the request number.
const target = (r) => r.targetId || r.id;

async function extensionDetail(r) {
  const id = target(r);
  const x = await chrome.management.get(id).catch(() => null);
  if (!x) throw new Error(`no extension with id ${id}`);
  return shapeInfo(x);
}

async function setExtensionEnabled(r) {
  const id = target(r);
  const enabled = r.enabled;
  if (id === chrome.runtime.id && !enabled) throw new Error("refusing to disable the bridge itself");
  const x = await chrome.management.get(id).catch(() => null);
  if (!x) throw new Error(`no extension with id ${id}`);
  if (x.mayDisable === false && !enabled) throw new Error(`${x.name} cannot be disabled by an extension`);
  if (Boolean(enabled) === Boolean(x.enabled)) return { id, enabled: x.enabled, unchanged: true };
  if (enabled) await chrome.management.setEnabled(id, true);
  else await chrome.management.setEnabled(id, false);
  const after = await chrome.management.get(id).catch(() => null);
  return { id, enabled: Boolean(after && after.enabled) };
}

async function reloadExtension(r) {
  const id = target(r);
  if (id === chrome.runtime.id) throw new Error("refusing to reload the bridge itself: the reply would be lost");
  const x = await chrome.management.get(id).catch(() => null);
  if (!x) throw new Error(`no extension with id ${id}`);
  if (typeof chrome.management.reload === "function") {
    await chrome.management.reload(id);
    return { id, reloaded: true, how: "management.reload" };
  }
  // Older/limited builds: a disable+enable cycle restarts the extension, but it
  // does NOT re-read the folder. Say so rather than implying a code refresh.
  await chrome.management.setEnabled(id, false);
  await chrome.management.setEnabled(id, true);
  const after = await chrome.management.get(id).catch(() => null);
  return { id, reloaded: Boolean(after && after.enabled), how: "setEnabled(false)+setEnabled(true)", rereadFromDisk: false };
}

async function uninstallExtension(r) {
  const id = target(r);
  if (id === chrome.runtime.id) throw new Error("refusing to uninstall the bridge itself: the reply would be lost");
  const x = await chrome.management.get(id).catch(() => null);
  if (!x) throw new Error(`no extension with id ${id}`);
  // Await it: dropping the promise made a refusal indistinguishable from a
  // removal (measured: requested:true while the extension was still listed).
  let settled = null;
  let error = null;
  try {
    await chrome.management.uninstall(id, { showConfirmDialog: false });
    settled = "uninstalled";
  } catch (e) {
    error = String(e && e.message ? e.message : e).slice(0, 200);
  }
  const still = await chrome.management.get(id).catch(() => null);
  return {
    id,
    name: x.name,
    removed: !still,
    outcome: settled || "refused",
    error,
    requiresUserConfirm: Boolean(still) && !error,
  };
}

async function loadExtension({ path: dir }) {
  if (!dir) throw new Error("path is required");
  const dp = chrome.developerPrivate;
  if (!dp || typeof dp.loadUnpacked !== "function") {
    throw new Error(
      "loadUnpacked needs chrome.developerPrivate, which this extension does not receive; " +
        "load unpacked folders from chrome://extensions, or use the agent browser's own Extensions.loadUnpacked",
    );
  }
  await dp.loadUnpacked({ failQuietly: true, populateError: true, retryGuid: "", useDraggedPath: false, filePath: dir });
  const all = await chrome.management.getAll();
  const hit = all.find((x) => (x.installType === "development" && x.name));
  return { requested: dir, extensions: all.filter((x) => x.installType === "development").map(shapeInfo), lastLoaded: hit ? shapeInfo(hit) : null };
}

async function handle(request) {
  if (request.type === "cookies") {
    const cookies = await readCookies(request.domains);
    return { ok: true, data: { cookies, count: cookies.length } };
  }
  if (request.type === "setCookies") {
    const result = await applyCookies(request.cookies);
    return { ok: true, data: result };
  }
  if (request.type === "removeCookies") {
    return { ok: true, data: await removeCookies(request.cookies) };
  }
  if (request.type === "tabOpen") return { ok: true, data: await openTab(request) };
  if (request.type === "extList") return { ok: true, data: await listExtensions() };
  if (request.type === "extDetail") return { ok: true, data: await extensionDetail(request) };
  if (request.type === "extEnable") return { ok: true, data: await setExtensionEnabled(request) };
  if (request.type === "extReload") return { ok: true, data: await reloadExtension(request) };
  if (request.type === "extUninstall") return { ok: true, data: await uninstallExtension(request) };
  if (request.type === "extLoad") return { ok: true, data: await loadExtension(request) };
  if (request.type === "tabInfo") return { ok: true, data: await tabInfo(request.tabId) };
  if (request.type === "tabClose") return { ok: true, data: await closeTab(request.tabId) };
  if (request.type === "opRun") return { ok: true, data: await runOp(request) };
  if (request.type === "ping") {
    return { ok: true, data: { alive: true, manifest: chrome.runtime.getManifest().version } };
  }
  return { ok: false, error: `unsupported request type: ${request.type}` };
}

let looping = false;

async function announce() {
  await call("/extension/hello", {
    method: "POST",
    body: JSON.stringify({
      extensionId: chrome.runtime.id,
      manifestVersion: chrome.runtime.getManifest().version,
    }),
  }).catch(() => {});
}

async function loop() {
  if (looping) return;
  looping = true;
  let backoff = 1000;
  await announce();
  while (looping) {
    let request = null;
    try {
      const timer = new Promise((r) => setTimeout(() => r({ timeout: true }), POLL_HOLD_MS + 4000));
      const next = await Promise.race([
        call(`/extension/poll?hold=${POLL_HOLD_MS}`),
        timer,
      ]);
      if (next?.timeout) continue;
      backoff = 1000;
      requests += 1;
      request = next?.request || null;
      if (next?.hello) {
        await call("/extension/hello", {
          method: "POST",
          body: JSON.stringify({
            extensionId: chrome.runtime.id,
            manifestVersion: chrome.runtime.getManifest().version,
            chrome: typeof chrome.runtime.getManifest === "function" ? "mv3" : "?",
          }),
        }).catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }
    if (!request) continue;
    let reply;
    try {
      reply = await handle(request);
    } catch (e) {
      reply = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    await call("/extension/result", {
      method: "POST",
      body: JSON.stringify({ _rid: request._rid, ...reply }),
    }).catch(() => {});
  }
}

function start() {
  loop().catch(() => {
    looping = false;
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "ab-status") {
    if (!looping) start();
    respond({ looping, base, hasKey: Boolean(key), polled: requests });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) start();
});
start();
