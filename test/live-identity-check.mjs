// Live check against the user's real browser: host the bridge, let the loaded
// extension register, and pull cookies for the domains on the command line.
//
// Read-only by default. It prints NO cookie values anywhere — counts, names,
// domains and value lengths only — because proving the values are plaintext
// does not require putting them on screen.
//
//   node test/live-identity-check.mjs github.com
//   node test/live-identity-check.mjs github.com --use   # also drive them in the agent browser
import { IdentityBridge } from "../src/bridge.js";
import { AgentBrowser } from "../src/agent-browser.js";

const hosts = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const alsoUse = process.argv.includes("--use");
if (hosts.length === 0) {
  console.log("usage: node test/live-identity-check.mjs <domain> [domain...] [--use]");
  process.exit(2);
}

const bridge = new IdentityBridge({ port: Number(process.env.AGENT_BROWSER_BRIDGE_PORT || 8791) });
await bridge.start();
console.log(`bridge hosted on 127.0.0.1:${bridge.port}; waiting for the extension to call in`);

// The worker keeps a stale key until its next attempt fails, and its backoff
// after a period with no server is up to 30 s, so allow for that.
let waited = 0;
while (!(await bridge.ready()) && waited < 60000) {
  await new Promise((r) => setTimeout(r, 1000));
  waited += 1000;
  if (waited % 10000 === 0) console.log(`  still waiting (${waited / 1000}s)…`);
}
if (!(await bridge.ready())) {
  console.log("FAIL no extension registered within 60s. Status:", JSON.stringify(await bridge.status()));
  // A refused poll with the right key means the worker is not reaching us.
  await bridge.stop();
  process.exit(1);
}
console.log(`OK extension registered after ${waited / 1000}s`, JSON.stringify(await bridge.status()));

const cookies = await bridge.cookies(hosts);
const encrypted = cookies.filter((c) => String(c.value).startsWith("__encrypted__")).length;
console.log(`\ncookies for ${hosts.join(", ")}: ${cookies.length} (encrypted-looking: ${encrypted})`);
const byDomain = new Map();
for (const c of cookies) {
  const key = `${c.domain}|${c.path}`;
  byDomain.set(key, (byDomain.get(key) || 0) + 1);
}
for (const c of cookies) {
  console.log(
    `  ${String(c.domain).padEnd(22)} ${String(c.name).padEnd(28)} ` +
      `len=${String((c.value || "").length).padEnd(5)} ` +
      `secure=${c.secure} httpOnly=${c.httpOnly} sameSite=${c.sameSite} ` +
      `expires=${c.expires ?? "session"}`
  );
}

if (alsoUse && cookies.length) {
  console.log("\nopening an agent browser with those cookies");
  const agent = new AgentBrowser({ scope: "live-check", headless: true });
  try {
    await agent.start();
    const restored = await agent.restoreCookies(cookies);
    console.log(`  restored ${restored} cookies into an ephemeral profile`);
    const page = await agent.page(`https://${hosts[0]}`);
    const title = await page.title();
    // GitHub publishes the signed-in account in a meta tag; reading it proves
    // the session carried over without printing any credential.
    const who = await page
      .evaluate(() => document.querySelector('meta[name="user-login"]')?.content || null)
      .catch(() => null);
    const url = page.url();
    console.log(`  final url: ${url}`);
    console.log(`  title: ${title}`);
    console.log(`  logged in as: ${who ?? "(no user-login meta)"}`);
    await page.close().catch(() => {});
  } finally {
    await agent.close().catch(() => {});
  }
}

await bridge.stop();
console.log("\nbridge stopped; nothing was written to your browser or to disk");
