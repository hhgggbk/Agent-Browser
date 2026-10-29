// The safety-critical properties of "open a page in the user's own browser".
//
// Default run does NOT launch Chrome — the guard rails and the argument shape are
// all that can be asserted without putting a tab on his screen.
//
//   node test/verify-user-browser.mjs              # rails only
//   node test/verify-user-browser.mjs --real [url] # his running Chrome, background-open proof
//
// The --real run measures the thing that only his machine can answer: Chrome
// activates a tab it opens from the command line (measured 2026-10-18: tab count
// 8 -> 9 with selected 7 -> 8), and the UIA select-back puts him where he was.
import { chromeArgsFor, openInUserBrowser, userChromeRunning } from "../src/user-browser.js";
import { listChromeTabstrips, closeChromeTab } from "../src/win-tabs.js";
import { GuardViolation, assertGuard, guardFromConfig } from "../src/guard.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? ` — ${detail}` : ""));
}

// 1. What makes this work at all: we never touch the profile or a debug
//    transport, so Chrome's default-dir gate is not consulted — and equally,
//    nothing is left open that could read the tab back.
const argv = chromeArgsFor("https://example.com/");
check("argv is just the url", argv.length === 1 && argv[0] === "https://example.com/", JSON.stringify(argv));
const joined = chromeArgsFor("https://example.com/", { window: true }).join(" ");
check("--new-window only when asked",
  !argv.join(" ").includes("--new-window") && joined.includes("--new-window"), joined);
check("no --user-data-dir and no --remote-debugging anywhere",
  !/--user-data-dir|--remote-debugging/.test(argv.join(" ") + " " + joined));

(async () => {
  // 2. The 禁区 rule applies before anything reaches his browser.
  let err = null;
  try { await openInUserBrowser("https://shop.example.com/pay/confirm"); } catch (e) { err = e; }
  check("a payment page is refused before Chrome is invoked",
    err instanceof GuardViolation && err.guard.category === "payment", `err=${err && err.name}`);

  let err2 = null;
  try { await openInUserBrowser("https://github.com/settings/tokens"); } catch (e) { err2 = e; }
  check("a token page is refused too", err2 instanceof GuardViolation, `err=${err2 && err2.name}`);

  // 3. opt-out is honoured like everywhere else — asserted at the guard layer,
  //    because calling openInUserBrowser would really put a tab on his screen.
  let err3 = null;
  try { assertGuard("https://example.com/settings/tokens", guardFromConfig({ enabled: false })); }
  catch (e) { err3 = e; }
  check("guard.enabled=false disables the rule", err3 === null, String(err3 && err3.message).slice(0, 60));

  const wins = await userChromeRunning();
  check("running-detection returns a list of window titles", Array.isArray(wins), `n=${wins.length}`);

  if (process.argv.includes("--real")) {
    const url = process.argv[process.argv.indexOf("--real") + 1] || "https://example.com/";
    const before = await listChromeTabstrips();
    if (!before.ok || !before.windows.length) {
      check("his Chrome is running with a tab strip UIA can read", false, before.error || "no chrome windows");
    } else {
      const w0 = before.windows[0];
      check("UIA sees only browser tabs, not the page's own ARIA tabs",
        w0.count > 0 && w0.selected >= 0 && w0.titles.every((t) => typeof t === "string"),
        `tabs=${w0.count} selected=${w0.selected}`);

      const r = await openInUserBrowser(url);
      const after = await listChromeTabstrips();
      const w1 = after.windows.find((w) => w.hwnd === w0.hwnd) || after.windows[0];
      check("the page really opened in his running browser",
        Boolean(r.launched) && w1.count === w0.count + 1,
        `count ${w0.count} -> ${w1.count}${r.error ? " err=" + r.error : ""}`);
      check("he is still on the tab he was reading",
        r.restored === true && w1.selected === w0.selected,
        `selected ${w0.selected} -> ${w1.selected} restored=${r.restored}${r.restoreError ? " " + r.restoreError : ""}`);
      if (r.focusBefore && r.focusBefore.hwnd !== w0.hwnd) {
        check("the app he was typing in got the focus back",
          r.focusRestored === true, `rung=${r.focusRung} skipped=${r.focusSkipped || "no"}`);
      } else {
        check("focus handback not needed (Chrome already had it)", true, "n/a");
      }

      if (process.argv.includes("--keep")) {
        console.log(`\n  --keep：${url} 那页留在标签号 ${r.tab && r.tab.index}，你自己关。`);
      } else if (r.tab && r.tab.hwnd === w0.hwnd) {
        const c = await closeChromeTab(r.tab.hwnd, r.tab.index);
        const cleaned = await listChromeTabstrips();
        const w2 = cleaned.windows.find((w) => w.hwnd === w0.hwnd) || cleaned.windows[0];
        check("the test closes the tab it opened, and only that one",
          c.ok === true && w2.count === w0.count,
          `closed=[${String(c.closedTitle).slice(0, 20)}] count ${w1.count} -> ${w2.count}${c.error ? " err=" + c.error : ""}`);
        check("he is still on his own tab after the cleanup",
          w2.selected === w0.selected, `selected=${w2.selected}`);
      } else {
        check("cleanup skipped: no tab index was reported", false, JSON.stringify(r.tab));
      }
      console.log(`\n  开的是 ${url}；标签页标题只读不回写，UIA 看不到页面内容。`);
    }
  } else {
    console.log("\n  跳过真机段：加 --real [url] 才会在他的浏览器里实测后台开页。");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
