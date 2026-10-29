// Diagnostic page inside the extension. Answers two separate questions that
// look identical from the outside: can this extension reach 127.0.0.1 at all,
// and is its service worker actually running? Read window.__probe over CDP.
//
// No top-level await here: this file is loaded as a classic script, where that
// is a parse error, and the whole probe silently reports `undefined`.
(() => {
  const out = document.getElementById("out");
  const report = { started: true };
  window.__probe = report;
  window.onerror = (m) => { report.pageError = String(m); };

  const record = async (key, fn) => {
    try {
      report[key] = await fn();
    } catch (e) {
      report[key] = "ERR " + (e && e.message ? e.message : String(e));
    }
    if (out) out.textContent = JSON.stringify(report, null, 2);
  };

  const cfg = fetch(chrome.runtime.getURL("bridge-config.json"))
    .then((r) => r.json())
    .catch(() => ({}));

  record("page_apis", () => ({
    cookies: typeof chrome.cookies,
    alarms: typeof chrome.alarms,
    runtimeId: chrome.runtime.id,
    manifestVersion: chrome.runtime.getManifest().manifest_version,
  }));

  record("config_file", async () => {
    const c = await cfg;
    return JSON.stringify({ port: c.port, keyLen: c.key ? String(c.key).length : 0 });
  });

  record("localhost_fetch", async () => {
    const port = (await cfg).port || 8791;
    const r = await fetch(`http://127.0.0.1:${port}/status`);
    return `${port} -> ${r.status} ${(await r.text()).slice(0, 140)}`;
  });

  record("wake_worker", () => new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMEOUT no listener"), 8000);
    chrome.runtime.sendMessage({ type: "ab-status" }, (resp) => {
      const err = chrome.runtime.lastError;
      clearTimeout(timer);
      resolve(err ? "lastError: " + err.message : JSON.stringify(resp));
    });
  }));

  record("cookies_now", async () => {
    const jar = await chrome.cookies.getAll({ domain: "127.0.0.1" });
    // Names and lengths only: proving the value is plaintext must not put the
    // plaintext on screen.
    return jar.length
      ? jar.map((c) => `${c.name} len=${(c.value || "").length}`).join(", ")
      : "(empty)";
  });

  // No reload button on purpose. Measured 2026-10-19 on Chrome 155 with a
  // throwaway profile: one chrome.runtime.reload() on a hand-loaded unpacked
  // extension is final — the worker never calls in again — and the only rescue,
  // --disable-features=ExtensionDisableUnsupportedDeveloper, has to be on the
  // command line of the browser at launch, which his running Chrome cannot get.
  // Switching versions is done by toggling the extension off and on instead.
})();
