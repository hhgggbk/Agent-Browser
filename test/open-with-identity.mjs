// Open a VISIBLE browser with a site's identity carried over from the user's
// own Chrome. Same capture path as the silent flow (extension bridge), the only
// difference is headless:false — that is the point of this script.
//
//   node test/open-with-identity.mjs doubao.com
//
// Prints cookie names/lengths only, never values. Keeps the window open until
// the process is stopped; Ctrl+C closes the browser and wipes the profile.
import { IdentityBridge } from "../src/bridge.js";
import { AgentBrowser } from "../src/agent-browser.js";

const domains = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const target = domains[0] ? `https://www.${domains[0].replace(/^\./, "").replace(/^www\./, "")}` : null;
if (!domains.length || !target) {
  console.log("usage: node test/open-with-identity.mjs <domain> [domain...]");
  process.exit(2);
}

const bridge = new IdentityBridge({ port: Number(process.env.AGENT_BROWSER_BRIDGE_PORT || 8791) });
let agent = null;

async function shutdown(code) {
  try { if (agent) await agent.close(); } catch {}
  try { await bridge.stop(); } catch {}
  console.log("closed; temp profile wiped");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await bridge.start();
console.log(`bridge on 127.0.0.1:${bridge.port}; waiting for the extension (backoff after idle can take ~30s)`);
let waited = 0;
while (!(await bridge.ready()) && waited < 60000) {
  await new Promise((r) => setTimeout(r, 1000));
  waited += 1000;
  if (waited % 10000 === 0) console.log(`  still waiting (${waited / 1000}s)…`);
}
if (!(await bridge.ready())) {
  console.log("FAIL no extension registered within 60s");
  await shutdown(1);
}

const cookies = await bridge.cookies(domains);
console.log(`\ncookies for ${domains.join(", ")}: ${cookies.length}`);
for (const c of cookies) {
  console.log(`  ${String(c.domain).padEnd(24)} ${String(c.name).padEnd(30)} len=${String((c.value || "").length).padEnd(5)} httpOnly=${c.httpOnly} expires=${c.expires ?? "session"}`);
}
if (!cookies.length) {
  console.log("你的 Chrome 里这些域没有 cookie —— 没有可带的登录态，先在 Chrome 里登录一次");
  await shutdown(1);
}

console.log(`\nopening a VISIBLE browser at ${target}`);
agent = new AgentBrowser({ scope: "visible-" + domains[0], headless: false });
await agent.start();
const n = await agent.restoreCookies(cookies);
console.log(`restored ${n} cookies; window is open`);

const page = await agent.page(target);
await page.waitForTimeout(5000);
const seen = await page.evaluate(() => ({
  title: document.title,
  url: location.href,
  bodyChars: document.body ? document.body.innerText.length : 0,
  loginHint: document.body ? /登录|log\s?in/i.test(document.body.innerText.slice(0, 3000)) : false,
})).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
console.log("after load:", JSON.stringify(seen));
console.log("\nwindow stays open. Ctrl+C (or ask me) to close and wipe the temp profile.");
setInterval(() => {}, 1 << 30);
