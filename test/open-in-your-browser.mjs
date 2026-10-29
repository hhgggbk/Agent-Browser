// Opens a page in the user's OWN Chrome profile, in place: no second browser
// instance, no copy, no extension. The credentials are already there because it
// is the real profile.
//
//   node test/open-in-your-browser.mjs                     # doubao.com
//   node test/open-in-your-browser.mjs https://github.com  # any url
//   HEADLESS=1 node test/open-in-your-browser.mjs          # no window
//
// Safety rails, in order: refuse to run if anything still holds the profile
// (browser.lock), print nothing that could be a credential, close the browser
// through CDP so Chrome marks the profile as a clean exit rather than a crash,
// and never delete a profile we did not create.
import { AgentBrowser } from "../src/agent-browser.js";
import { findUserProfile, probePort, CHROME_EXE } from "../src/capture.js";
import fs from "node:fs";
import path from "node:path";

const url = process.argv.slice(2).find((a) => !a.startsWith("--")) || "https://www.doubao.com/";
const headless = process.env.HEADLESS === "1";
const PORT_PROBE = 9333;

function line(k, v) {
  console.log(`${k.padEnd(28)} ${v}`);
}

const found = findUserProfile();
if (!found) {
  console.error("no Chrome user data dir found");
  process.exit(1);
}
const profileRoot = found.root;
if (!profileRoot) {
  console.error("no Chrome user data dir found");
  process.exit(1);
}
const lock = path.join(profileRoot, "browser.lock");
line("user data dir", `${profileRoot} (${found.browser})`);
line("chrome executable", CHROME_EXE);
if (fs.existsSync(lock)) {
  console.error(`REFUSING: that profile is in use (browser.lock is present). Close Chrome first.`);
  process.exit(1);
}
line("profile lock", "absent — Chrome is closed");

// Does Chrome's 136+ "no debugging port on the default data directory" gate
// apply here? This is the positive control the synthetic-profile runs could
// never produce. It is opt-in (WITHPORT=1) because the port question must not
// contaminate the primary arm, which drives through Playwright's pipe.
const withPort = process.env.WITHPORT === "1";
const agent = new AgentBrowser({
  headless,
  profileDir: profileRoot,
  // A real profile with thousands of cookies and extensions boots far slower
  // than a throwaway one.
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 120000),
  ...(withPort ? { extraArgs: [`--remote-debugging-port=${PORT_PROBE}`] } : {}),
});

let exited = false;
try {
  await agent.start();
} catch (e) {
  exited = true;
  const lockNow = fs.existsSync(lock) ? "browser.lock APPEARED (Chrome did start)" : "no browser.lock (Chrome never got that far)";
  console.error(`launch on the real profile FAILED\n  ${String(e.message).replace(/\n/g, "\n  ").slice(0, 900)}\n  ${lockNow}`);
}

if (!exited) {
  try {
    const portUp = await probePort(PORT_PROBE);
    line("http debug port bound",
      withPort ? (portUp ? `YES on ${PORT_PROBE}` : "NO — the default-dir gate refused it") : `(not requested; probing anyway: ${portUp ? "something is on " + PORT_PROBE : "nothing on " + PORT_PROBE})`);

    const page = await agent.page(url);
    // Read the page the way a user would look at it: identity, not values.
    const info = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      ready: document.readyState,
      composer: Boolean(document.querySelector("textarea,[contenteditable=true]")),
      inputs: document.querySelectorAll("input,textarea,select,button,[contenteditable=true]").length,
      links: document.querySelectorAll("a[href]").length,
      loginHints: ["user-login", "user", "uid", "username"]
        .map((n) => document.querySelector(`meta[name="${n}"]`)?.content || "")
        .filter(Boolean),
    })).catch((e) => ({ error: e.message.slice(0, 120) }));

    line("page url", info.url || "(unreadable)");
    line("document title", JSON.stringify(info.title));
    line("interactive elements", `${info.inputs ?? "?"} fields, ${info.links ?? "?"} links, composer=${info.composer ? "yes" : "no"}`);
    if (info.loginHints?.length) line("identity meta", info.loginHints.join(","));
    if (info.error) line("evaluate error", info.error);

    const jar = await agent.context.cookies(["https://www.doubao.com"]);
    // Names and count only: values are credentials and are never printed.
    line("cookies present for site", `${jar.length} (${jar.map((c) => c.name).slice(0, 8).join(",")}${jar.length > 8 ? ",…" : ""})`);
    line("verdict", jar.length > 0 && Boolean(info.composer || (info.links ?? 0) > 0)
      ? "your real profile drove the page with your existing session — no second instance, no extension"
      : "read the numbers above; the page may have rendered a login wall");

    await page.close().catch(() => {});
  } finally {
    // Graceful close, so Chrome writes a clean exit into his profile.
    await agent.close();
    line("closed", "gracefully via CDP");
  }
}

line("profile still there", fs.existsSync(profileRoot) ? "yes — not ours to delete" : "NO (bug!)");
process.exit(exited ? 1 : 0);
