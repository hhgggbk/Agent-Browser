// Guard verification: pure matcher first (fast, no browser), then the real
// navigation choke points in a headless Chromium against a local fixture site.
//
// The three things that must each be proven separately:
//   1. the rule list catches the four禁区 categories and nothing else,
//   2. agent.page() refuses before the request goes out AND after a redirect,
//   3. in-page navigation (which never passes through page()) is caught,
//      the page is closed, and the event is recorded.
import { AgentBrowser } from "../src/agent-browser.js";
import { Broker } from "../src/broker.js";
import { DEFAULT_DENIED, findViolation, guardFromConfig, GuardViolation } from "../src/guard.js";
import http from "node:http";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? ` — ${detail}` : ""));
}
function blocked(url, opts) {
  const f = findViolation(url, opts || guardFromConfig({}));
  return f ? f.rule.category : null;
}
function expectBlocked(name, url, category) {
  const got = blocked(url);
  check(`${name} blocked`, got === category, `got=${got || "ALLOWED"} want=${category}  url=${url}`);
}
function expectAllowed(name, url) {
  check(`${name} allowed`, blocked(url) === null, `url=${url}`);
}

const SITE_PORT = 9812;
const origin = `http://127.0.0.1:${SITE_PORT}`;
const hits = [];

function startSite() {
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "Content-Type": "text/html", ...headers });
      res.end(body);
    };
    if (req.url.startsWith("/bounce")) {
      send(302, "", { Location: "/settings/tokens" });
      return;
    }
    if (req.url.startsWith("/pay")) {
      send(200, `<html><body><h1>CASHIER</h1><button onclick="location.href='/pay/confirm'">pay</button></body></html>`);
      return;
    }
    // Does a fetch to a禁区 path get caught? Nothing navigates here, so this
    // measures the guard's real blind spot instead of guessing about it.
    if (req.url.startsWith("/apitest")) {
      send(200, `<html><body><script>fetch('/pay/confirm').then(function(r){
        var d=document.createElement('div'); d.id='r'; d.textContent='status='+r.status;
        document.body.appendChild(d); })
        .catch(function(e){ var d=document.createElement('div'); d.id='r'; d.textContent='ERR'+e.message; document.body.appendChild(d); });</script></body></html>`);
      return;
    }
    // A normal page whose own script walks into a禁区 without any page() call.
    if (req.url.startsWith("/selfnav")) {
      send(200, `<html><body><span id="s">HOME</span><script>setTimeout(function(){location.href='/account/delete'},50)</script></body></html>`);
      return;
    }
    // A SPA-style link: the agent clicks, the browser navigates.
    if (req.url.startsWith("/home")) {
      send(200, `<html><body><a id="l" href="/billing/invoice-1">billing</a></body></html>`);
      return;
    }
    send(200, `<html><body><span id="s">HOME</span></body></html>`);
  });
  return new Promise((resolve) => server.listen(SITE_PORT, "127.0.0.1", () => resolve(server)));
}

// ---------- 1. the rule list ----------
expectBlocked("checkout", "https://shop.example.com/cart/checkout", "payment");
expectBlocked("pay exact", "https://shop.example.com/pay", "payment");
expectBlocked("pay with query", "https://shop.example.com/pay?next=/home", "payment");
expectBlocked("pay nested", "https://shop.example.com/a/b/pay/confirm", "payment");
expectBlocked("withdraw", "https://bank.example.com/user/withdraw", "payment");
expectBlocked("tokens", "https://github.com/settings/tokens", "security");
expectBlocked("password", "https://example.com/account/password/edit", "security");
expectBlocked("oauth grant", "https://example.com/settings/applications/oauth", "security");
expectBlocked("logout", "https://example.com/signout", "security");
expectBlocked("realname", "https://example.com/verify/realname", "kyc");
expectBlocked("kyc encoded zh", "https://example.com/member/%E5%AE%9E%E5%90%8D%E8%AE%A4%E8%AF%81", "kyc");
expectBlocked("delete account", "https://example.com/settings/account/delete", "deletion");
expectBlocked("deactivate", "https://example.com/deactivate", "deletion");

expectAllowed("profile page", "https://github.com/hhgggbk");
expectAllowed("repo list", "https://github.com/foo/bar/pulls/12");
expectAllowed("api data", "https://api.example.com/v1/repos?per_page=100");
expectAllowed("pay is not display", "https://example.com/settings/display");
expectAllowed("company is not pay", "https://example.com/about/company");
expectAllowed("bare origin", "https://github.com/");

check("look-alike words stay open", blocked("https://example.com/survey/results") === null);
expectBlocked("hash route", "https://spa.example.com/#/pay/checkout", "payment");
expectAllowed("docs anchor is not a route", "https://example.com/docs-overview#password");

// ---------- 2. matching is glob, not regex ----------
{
  const g = guardFromConfig({ extraDenied: ["*/a.b"] });
  const f = findViolation("https://example.com/x/a.b", g);
  const g2 = findViolation("https://example.com/x/axb", g);
  check("regex metachars in a rule are literal", f !== null && g2 === null,
    `a.b=${f ? "blocked" : "allowed"} axb=${g2 ? "blocked" : "allowed"}`);
}
{
  const g = guardFromConfig({ extraDenied: ["*/p?g"] });
  check("? matches exactly one char",
    findViolation("https://example.com/x/peg", g) !== null &&
      findViolation("https://example.com/x/peeg", g) === null);
}
{
  const g = guardFromConfig({ allow: ["*/billing/dashboard"] });
  const f = findViolation("https://example.com/billing/dashboard", g);
  const still = findViolation("https://example.com/billing/pay-now", g);
  check("allow exception opens only that path",
    f === null && still !== null, `dashboard=${f ? "blocked" : "open"} pay-now=${still ? "blocked" : "open"}`);
}
{
  const g = guardFromConfig({ extraDenied: [{ host: "only.test", path: "/*" }] });
  check("host-scoped rule spares other hosts",
    findViolation("https://only.test/anything", g) !== null &&
      findViolation("https://other.test/anything", g) === null);
  check("host-scoped rule covers subdomains",
    findViolation("https://a.only.test/x", g) !== null);
}
{
  const off = guardFromConfig({ enabled: false });
  check("enabled:false empties the rule set",
    off.enabled === false && off.denied.length === 0 && findViolation("https://e.com/pay", off) === null);
  check("defaults stay on when config omits guard", guardFromConfig(undefined).denied.length === DEFAULT_DENIED.length);
}
check("non-http URLs are not the guard's business",
  findViolation("about:blank") === null && findViolation("data:text/html,hi") === null);

// ---------- 3. real navigation ----------
const server = await startSite();
const agent = new AgentBrowser({ headless: true });
await agent.start();

try {
  // pre-goto: the request must never leave the browser
  const before = hits.length;
  let err = null;
  try { await agent.page(`${origin}/pay/checkout`); } catch (e) { err = e; }
  check("page() throws before the request goes out",
    err instanceof GuardViolation && hits.length === before,
    `err=${err && err.name} requests=${hits.length - before}`);
  check("error names the matched rule and category",
    err && err.guard && err.guard.category === "payment" && err.message.includes(err.guard.path),
    (err && err.message.split("\n")[0] || "").slice(0, 90));

  // post-goto recheck: server 302 into a禁区
  const before2 = hits.length;
  let err2 = null;
  let pageAfter = null;
  try { pageAfter = await agent.page(`${origin}/bounce`); } catch (e) { err2 = e; }
  check("redirect into a禁区 is caught on the final URL",
    err2 instanceof GuardViolation && err2.url.includes("/settings/tokens"),
    `err=${err2 && err2.name} url=${(err2 && err2.url) || ""} requests=${hits.length - before2}`);
  check("no page handed back from a blocked navigation", pageAfter === null || pageAfter.isClosed());

  // benign navigation still works
  const ok = await agent.page(`${origin}/home`);
  check("normal page() unaffected", (await ok.textContent("#l")) === "billing", `url=${ok.url()}`);

  // in-page link click
  const before3 = agent.guardViolations.length;
  await ok.click("#l");
  await new Promise((r) => setTimeout(r, 800));
  const v = agent.guardViolations[before3];
  check("click into a禁区 closes the page and is recorded",
    Boolean(v) && ok.isClosed() && v.category === "payment",
    JSON.stringify(v || {}).slice(0, 120));

  // script-driven navigation, no page() involved at all
  const p2 = await agent.page(`${origin}/selfnav`);
  await new Promise((r) => setTimeout(r, 1200));
  const v2 = agent.guardViolations[agent.guardViolations.length - 1];
  check("JS location change into a禁区 is caught",
    p2.isClosed() && v2 && v2.category === "deletion",
    JSON.stringify(v2 || {}).slice(0, 120));

  check("violations accumulate, not overwrite", agent.guardViolations.length >= 2,
    `n=${agent.guardViolations.length}`);

  // same-document navigations: does framenavigated see them at all?
  const p3 = await agent.page(`${origin}/home`);
  const n0 = agent.guardViolations.length;
  await p3.evaluate(() => history.pushState({}, "", "/pay/checkout")).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const afterPush = agent.guardViolations.slice(n0);
  check("history.pushState into a禁区 is observed",
    afterPush.some((v) => v.url.includes("/pay/checkout")),
    `seen=${JSON.stringify(afterPush.map((v) => v.url))}`);
  check("the page caught by a pushState is closed", p3.isClosed());

  // hash-routed SPA: the pathname never changes, the route lives in the fragment
  const p4 = await agent.page(`${origin}/home`);
  const n1 = agent.guardViolations.length;
  await p4.evaluate(() => { location.hash = "#/pay/checkout"; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const afterHash = agent.guardViolations.slice(n1);
  check("a hash route into a禁区 is observed",
    afterHash.some((v) => v.url.includes("#/pay/checkout")),
    `seen=${JSON.stringify(afterHash.map((v) => v.url))}`);
  check("the page caught by a hash route is closed", p4.isClosed());

  // measured blind spot: the guard is a navigation guard, not a request filter
  const p5 = await agent.page(`${origin}/apitest`);
  await p5.waitForSelector("#r", { timeout: 5000 }).catch(() => {});
  const apiRes = await p5.textContent("#r").catch(() => "(no #r)");
  const apiHits = hits.filter((h) => h.startsWith("/pay/confirm")).length;
  check("fetch() to a禁区 path is NOT blocked (navigation-level guard)",
    apiRes === "status=200" && apiHits > 0,
    `${apiRes} server saw ${apiHits} /pay/confirm requests`);
  await p5.close();

  // broker config pass-through: extraDenied reaches the agent it launches
  const broker = new Broker({ guard: { extraDenied: ["*/selfnav"] } });
  const bAgent = await broker.startAgent({ headless: true });
  let err3 = null;
  try { await bAgent.page(`${origin}/selfnav`); } catch (e) { err3 = e; }
  check("guard config flows from Broker into AgentBrowser",
    err3 instanceof GuardViolation && err3.guard.path === "*/selfnav",
    `err=${err3 && err3.name}`);
  await broker.close();

  // explicit opt-out is honoured
  const off2 = new AgentBrowser({ headless: true, guard: { enabled: false } });
  await off2.start();
  const free = await off2.page(`${origin}/pay/checkout`);
  const h1 = await free.textContent("h1");
  check("guard.enabled=false lets the same URL through", h1 === "CASHIER", `h1=${h1}`);
  await off2.close();
} finally {
  await agent.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
