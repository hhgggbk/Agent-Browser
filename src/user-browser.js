// Open a page in the browser the user is already using, without a second
// instance and without any automation channel.
//
// Why this works where DevTools does not: chrome.exe invoked with a URL talks
// to the running browser over Chrome's own single-instance IPC, so the page
// lands as a new tab in his existing window, carrying his session natively. No
// --user-data-dir, no --remote-debugging-*, so the Chrome 136+ "no debugging on
// the default data directory" gate never enters the picture. Measured on this
// machine: that gate refuses BOTH --remote-debugging-port and Playwright's
// --remote-debugging-pipe on the default profile, so nothing external can read
// or drive those tabs.
//
// The one thing that route does by itself that he asked us not to do: Chrome
// activates the tab it just opened (measured: tab count 8 -> 9 and selected 7 ->
// 8). Windows UI Automation is the only channel left that can undo that on the
// default profile, so src/win-tabs.js reads the tab strip, and we put the
// selection back. That is focus control, not driving: UIA sees tab titles, never
// page content.
//
// The path-level禁区 still applies: refusing to send an agent's URL to his
// browser is the same rule as refusing to open it in the agent's own browser.

import { spawn, execFile } from "node:child_process";
import { CHROME_EXE } from "./capture.js";
import { assertGuard, guardFromConfig } from "./guard.js";
import { listChromeTabstrips, selectChromeTab, focusWindow } from "./win-tabs.js";

// Is his Chrome up? Only the browser process counts, not renderers.
export async function userChromeRunning() {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", "Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty MainWindowTitle"],
      (err, out) => resolve(String(out || "").trim().split(/\r?\n/).filter(Boolean)),
    );
  });
}

// The whole trick is what is NOT in here: no --user-data-dir (so it is his own
// default profile) and no --remote-debugging-* (so Chrome's debugging gate is
// never consulted, and nothing can read or drive the tab afterwards).
export function chromeArgsFor(url, { window = false } = {}) {
  const args = [String(url)];
  if (window) args.unshift("--new-window");
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until some Chrome window reports more tabs than it had, then returns it.
// Each UIA read costs ~1.7 s on this machine, so polling is coarse on purpose.
async function waitForNewTab(before, { deadlineMs = 12000, pollMs = 900 } = {}) {
  const byHwnd = new Map((before.windows || []).map((w) => [w.hwnd, w]));
  const end = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < end) {
    const now = await listChromeTabstrips();
    if (!now.ok) return { error: now.error, snapshot: now };
    last = now;
    for (const w of now.windows || []) {
      const prev = byHwnd.get(w.hwnd);
      if (!prev) {
        if (w.count > 0 && byHwnd.size === 0) return { window: w, prev: null, snapshot: now };
        continue;
      }
      if (w.count > prev.count) return { window: w, prev, snapshot: now };
    }
    await sleep(pollMs);
  }
  return { error: "no new tab appeared in time", snapshot: last };
}

// Which tab was he on? Titles are the stable handle; the index is the fallback.
function previousTabIndex(window, prev) {
  const titles = window.titles || [];
  const old = prev.titles || [];
  const title = prev.selected >= 0 ? old[prev.selected] : null;
  if (title) {
    for (let i = titles.length - 1; i >= 0; i--) {
      if (titles[i] === title && i !== window.selected) return i;
    }
  }
  return prev.selected < titles.length ? prev.selected : -1;
}

// Opens url in the user's running Chrome (or starts Chrome with his default
// profile if it is closed) and, unless told otherwise, puts his selection back
// where it was so the page lands in the background.
export async function openInUserBrowser(url, { window = false, guard, background = true, deadlineMs = 12000 } = {}) {
  const g = guardFromConfig(guard || {});
  assertGuard(url, g); // throws GuardViolation before anything reaches his browser

  const before = background ? await listChromeTabstrips() : { ok: false, windows: [], foreground: null };
  const proc = spawn(CHROME_EXE, chromeArgsFor(url, { window }), {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  proc.on("error", (e) => {
    err = e.message;
  });
  proc.unref();

  const out = {
    url,
    launched: false,
    stderr: null,
    restored: false,
    startedBrowser: !(before.ok && (before.windows || []).length),
    focusBefore: before.foreground || null,
  };

  const found = await waitForNewTab(before, { deadlineMs });
  if (found.window) {
    const w = found.window;
    const prevTitles = (found.prev && found.prev.titles) || [];
    const candidate = w.count - 1;
    // Chrome appends a command-line tab last; confirm that slot really is new
    // before anyone is told it is safe to close.
    const isNew = !prevTitles.length || !prevTitles.includes(w.titles[candidate]);
    out.tab = { hwnd: w.hwnd, tabs: w.count, index: candidate, indexIsNew: isNew, selectedBefore: w.selected };
  } else {
    out.tab = null;
  }
  if (found.error) out.error = found.error;

  if (found.window) {
    // Chrome appends the new tab and selects it; put him back on the old one.
    if (found.prev) {
      const back = previousTabIndex(found.window, found.prev);
      if (back >= 0 && found.window.selected !== back) {
        const sel = await selectChromeTab(found.window.hwnd, back);
        out.restored = Boolean(sel.ok) && sel.selectedAfter === back;
        out.selectedAfter = sel.selectedAfter ?? null;
        out.restoreError = sel.ok ? null : sel.error || null;
      } else if (found.window.selected === back) {
        out.restored = true; // it did not take the selection in the first place
      }
    }
    // He was in another app: hand that window back, since Chrome raises its own.
    // But only if Chrome is the one holding the focus right now — if he has
    // already moved on himself, forcing the old window forward would fight him.
    const nowFg = found.snapshot && found.snapshot.foreground;
    if (out.startedBrowser) {
      // We started his browser: the page he asked for is the thing to show, so
      // there is no "previous app" to hand the screen back to.
      out.focusRestored = false;
      out.focusSkipped = "browser was closed; we started it";
    } else if (background && before.foreground && before.foreground.hwnd && before.foreground.hwnd !== found.window.hwnd) {
      if (!nowFg || nowFg.hwnd === found.window.hwnd) {
        const f = await focusWindow(before.foreground.hwnd);
        out.focusRestored = Boolean(f.ok);
        out.focusRung = f.rung || null;
        out.focusError = f.ok ? null : f.error || "foreground lock held it back";
      } else {
        out.focusRestored = false;
        out.focusSkipped = `he is already in hwnd=${nowFg.hwnd}`;
      }
    }
  }

  const refusal = (err.match(/ERROR:[^\r\n]*/g) || []).slice(0, 3);
  out.stderr = refusal.join(" | ") || null;
  out.launched = Boolean(found.window) || (!err && !out.error);
  return out;
}
