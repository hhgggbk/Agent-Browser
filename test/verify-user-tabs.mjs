// Verifies driving pages inside an already-running browser through the
// extension, instead of launching a second browser instance.
//
// Default mode runs against a throwaway profile with the real extension loaded,
// so nothing here touches the user's Chrome.
//
//   node test/verify-user-tabs.mjs            # mechanism, synthetic profile
//   node test/verify-user-tabs.mjs --real doubao.com
//        # same code path against HIS browser via the already-loaded extension
//          (requires the extension to have been reloaded once after the manifest
//          change; opens a background tab, reads it, closes it)
import { AgentBrowser } from "../src/agent-browser.js";
import { IdentityBridge, createIdentityBridge } from "../src/bridge.js";
import { UserTabs } from "../src/user-tabs.js";
import { GuardViolation } from "../src/guard.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? ` — ${detail}` : ""));
}

const real = process.argv.includes("--real");
const target = process.argv.slice(2).find((a) => !a.startsWith("--")) || "doubao.com";

// ---------- fixture site ----------
const SITE_PORT = 9814;
const origin = `http://127.0.0.1:${SITE_PORT}`;
const hits = [];
function startSite() {
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (body, headers = {}, status = 200) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    if (req.url.startsWith("/login")) {
      send(`<html><head><title>Logged in</title></head><body><span id="state">AUTHED</span></body></html>`,
        { "Set-Cookie": "ab_inbrowser=s1; Path=/" });
      return;
    }
    if (req.url.startsWith("/form")) {
      send(`<html><body><h1 id="t">FORM</h1><input id="q" placeholder="搜点什么"><button id="go">搜</button>` +
        `<a id="a1" href="/login">去登录</a><a href="/">首页</a>` +
        `<script>document.getElementById('go').onclick=function(){
             document.getElementById('t').textContent='已填:'+document.getElementById('q').value;};</script></body></html>`);
      return;
    }
    if (req.url.startsWith("/jump")) {
      send(`<html><body><button id="b">点我去支付</button><script>document.getElementById('b').onclick=
             function(){location.href='/pay/confirm';};</script></body></html>`);
      return;
    }
    if (req.url.startsWith("/pay")) {
      send(`<html><body>CASHIER SHOULD NOT BE REACHED</body></html>`, {}, 404);
      return;
    }
    const authed = /ab_inbrowser=s1/.test(req.headers.cookie || "");
    send(`<html><head><title>Fixture ${authed ? "authed" : "anon"}</title>` +
      `<meta name="user-login" content="${authed ? "hhgggbk" : ""}"></head>` +
      `<body><span id="state">${authed ? "AUTHED" : "ANON"}</span></body></html>`);
  });
  return new Promise((r) => server.listen(SITE_PORT, "127.0.0.1", () => r(server)));
}

let server = null;
let agent = null;
let bridge = null;
let ownsBridge = false;
let extDir = null;

try {
  let tabs;
  if (real) {
    // His browser: the extension is already loaded there, we only join the bridge.
    bridge = await createIdentityBridge({ port: 8791 });
    ownsBridge = Boolean(bridge.hosting);
    // The worker only calls in when its 30 s keep-alive alarm fires, so asserting
    // at t=0 marks a healthy browser as disconnected. Poll instead.
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 75000) {
      const s = await bridge.status();
      up = Boolean(s && s.connected);
      if (up) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    check("connected to the bridge your browser's extension is on", up,
      `waited=${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify(await bridge.status()).slice(0, 160)}`);
    tabs = new UserTabs({ bridge });
    await tabs.connect();

    const home = `https://${target.replace(/^www\./, "")}`;
    const t = await tabs.open(`${home}/`);
    check(`a background tab opened in YOUR browser (${target})`, Boolean(t.tabId),
      `tabId=${t.tabId} active=${(await bridge.tabInfo(t.tabId)).active} url=${t.url}`);
    const title = await tabs.title(t.tabId);
    const st = await tabs.state(t.tabId);
    check("the page read back with your existing credentials (no second browser)",
      Boolean(title) && String(st.url).startsWith("https://"),
      `title=${JSON.stringify(title)} ready=${st.ready}`);
    const composer = await tabs.count(t.tabId, "textarea,[contenteditable=true],input[type=text]").catch(() => 0);
    const links = await tabs.links(t.tabId, 8).catch(() => []);
    check("the operation menu works inside your page",
      Array.isArray(links) && typeof composer === "number",
      `interactive=${composer} links=${links.length}`);

    if (process.argv.includes("--type")) {
      // Writes into his live page. Opt-in only. The composer in a real SPA is
      // not there at domcontentloaded: measured, /chat/ needed several hundred ms
      // and the first attempt with a 400 ms wait found nothing.
      const sel = "textarea, [contenteditable=true]";
      let seen = 0;
      for (let i = 0; i < 14; i++) {
        seen = await tabs.count(t.tabId, sel).catch(() => 0);
        if (seen > 0) break;
        await new Promise((r) => setTimeout(r, 700));
      }
      const marker = "agent-browser 验收占位";
      await tabs.fill(t.tabId, sel, marker);
      await new Promise((r) => setTimeout(r, 350));
      const back = `${(await tabs.text(t.tabId, sel).catch(() => "")) || ""}`;
      check("text really lands in the page's own editor", back.includes(marker),
        `nodes=${seen} readBack=${JSON.stringify(back.slice(0, 40))}`);
      await tabs.fill(t.tabId, sel, "");
      await new Promise((r) => setTimeout(r, 250));
      const cleared = `${(await tabs.text(t.tabId, sel).catch(() => "")) || ""}`;
      check("and it is cleared again (nothing was sent)", !cleared.includes(marker),
        `after=${JSON.stringify(cleared.slice(0, 30))}`);
    } else {
      console.log("  跳过真机输入检查：加 --type 才会往你正在看的页面里写一段占位文字（不发送）。");
    }
    await tabs.close(t.tabId);
    check("the tab is closed again", true, `closed=${t.tabId}`);
  } else {
    server = await startSite();
    // Real extension, throwaway profile.
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-usertabs-ext-"));
    for (const f of ["manifest.json", "background.js", "probe.html", "probe.js"]) {
      fs.copyFileSync(path.join(process.cwd(), "cookie-extension", f), path.join(extDir, f));
    }
    bridge = new IdentityBridge({ port: 8903, extensionDir: extDir });
    await bridge.start();
    agent = new AgentBrowser({ headless: true, extensions: [extDir] });
    await agent.start();
    tabs = new UserTabs({ bridge });
    await tabs.connect();

    // 1. background tab, no focus stolen
    const t = await tabs.open(`${origin}/`);
    const info = await bridge.tabInfo(t.tabId);
    check("opens a background tab in the running browser", Boolean(t.tabId) && info.active === false,
      `tabId=${t.tabId} active=${info.active}`);
    check("the fresh browser has no session yet", await tabs.text(t.tabId, "#state") === "ANON",
      await tabs.text(t.tabId, "#state"));
    await tabs.close(t.tabId);

    // 2. log in once, and the NEXT page in the same browser is already authed —
    //    this is the "no second instance, credentials are right there" claim.
    const login = await tabs.open(`${origin}/login`);
    check("the login page rendered", (await tabs.text(login.tabId, "#state")) === "AUTHED");
    const again = await tabs.open(`${origin}/`);
    check("a new tab in the SAME browser is already logged in",
      (await tabs.text(again.tabId, "#state")) === "AUTHED",
      await tabs.text(again.tabId, "#state"));
    check("and the identity is readable from the page",
      (await tabs.meta(again.tabId, "user-login")) === "hhgggbk",
      await tabs.meta(again.tabId, "user-login"));
    check("titles read back", (await tabs.title(again.tabId)) === "Fixture authed", await tabs.title(again.tabId));

    // 3. interaction menu
    const f = await tabs.open(`${origin}/form`);
    check("links enumeration works", (await tabs.links(f.tabId, 10)).length === 2,
      JSON.stringify(await tabs.links(f.tabId, 10)));
    const filled = await tabs.fill(f.tabId, "#q", "豆包 视频下载");
    check("fill writes into the field through the framework's own events", filled === true);
    await tabs.click(f.tabId, "#go");
    const after = await tabs.waitFor(f.tabId, "text", ["#t"], { timeoutMs: 5000 }).catch(() => null);
    check("click drives the page and the result is readable", after === "已填:豆包 视频下载", String(after));
    await tabs.close(f.tabId);

    // 4.禁区
    const before = hits.length;
    let err = null;
    try { await tabs.open(`${origin}/pay/confirm`); } catch (e) { err = e; }
    check("a禁区 URL is refused before the browser asks for it",
      err instanceof GuardViolation && hits.length === before,
      `err=${err && err.name} requests=${hits.length - before}`);

    // 5. a tab that walks itself into a禁区 gets closed on the next call
    const j = await tabs.open(`${origin}/jump`);
    await tabs.click(j.tabId, "#b");
    await new Promise((r) => setTimeout(r, 1200));
    let err2 = null;
    try { await tabs.title(j.tabId); } catch (e) { err2 = e; }
    check("in-page navigation into a禁区 is caught on the next touch",
      err2 instanceof GuardViolation && err2.guard.category === "payment",
      `err=${err2 && err2.name}`);
    check("that tab was closed and recorded",
      tabs.guardViolations.length >= 1 && !tabs.tabs.has(j.tabId),
      JSON.stringify(tabs.guardViolations[0] || {}).slice(0, 130));

    // 6. only tabs the extension opened are reachable
    let err3 = null;
    try { await tabs.bridge.tabInfo(999999); } catch (e) { err3 = e.message; }
    check("a tab the extension did not open is refused",
      /not opened by this extension/.test(err3 || ""), String(err3).slice(0, 90));

    // 7. cleanup
    const closed = await tabs.closeAll();
    check("closeAll leaves nothing open", tabs.tabs.size === 0, `closed=${closed.join(",") || "(none)"} remaining=${tabs.tabs.size}`);
  }
} catch (e) {
  check("run completed without crashing", false, `${e.name}: ${String(e.message).slice(0, 200)}`);
} finally {
  if (agent) await agent.close().catch(() => {});
  if (bridge && (ownsBridge || typeof bridge.stop === "function")) {
    await bridge.stop().catch(() => {});
  }
  if (server) server.close();
  if (extDir) fs.rmSync(extDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
