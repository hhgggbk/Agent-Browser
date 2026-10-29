// End-to-end verification: a throwaway "user browser" (temp profile, temp port),
// a local HTTP site that issues cookies, and the full broker round-trip.
//
// This never touches the user's real Chrome. The temp browser is launched with a
// CDP port so capture can attach; the port and profile are wiped afterwards.

import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runTask } from "../src/broker.js";
import { CHROME_EXE } from "../src/capture.js";

const execFileP = promisify(execFile);
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const TEST_PORT = 9777;
const SITE_PORT = 9778;

// A local site: /login issues a session cookie, /protected reads it, /refresh
// rotates it. That is enough to exercise capture, restore, and write-back.
function startSite() {
  let sessionCounter = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${SITE_PORT}`);
    if (url.pathname === "/login") {
      sessionCounter += 1;
      res.writeHead(200, {
        "Set-Cookie": `ab_session=s${sessionCounter}; Path=/; HttpOnly`,
        "Content-Type": "text/html",
      });
      res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
      return;
    }
    if (url.pathname === "/refresh") {
      sessionCounter += 1;
      res.writeHead(200, { "Set-Cookie": `ab_session=s${sessionCounter}; Path=/; HttpOnly`, "Content-Type": "text/html" });
      res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
      return;
    }
    if (url.pathname === "/newsite") {
      res.writeHead(200, { "Set-Cookie": `ab_extra=e1; Path=/`, "Content-Type": "text/html" });
      res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
      return;
    }
    // / and everything else: report what cookies we see.
    const cookies = req.headers.cookie || "";
    const has = /ab_session=/.test(cookies);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><span id="state">${has ? "AUTHED" : "ANON"}</span></body></html>`);
  });
  return new Promise((resolve) => server.listen(SITE_PORT, "127.0.0.1", () => resolve(server)));
}

async function waitForCDP(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  const server = await startSite();
  const origin = `http://127.0.0.1:${SITE_PORT}`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-user-"));

  // 1. "User browser": temp profile + CDP port, logged into the local site.
  const userCtx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME_EXE,
    headless: true,
    args: [
      `--remote-debugging-port=${TEST_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
    ],
  });
  const up = await userCtx.newPage();
  await up.goto(`${origin}/login`);
  await up.waitForSelector("#state");
  const userCookiesBefore = await userCtx.cookies();
  check("user browser holds session cookie", userCookiesBefore.some((c) => c.name === "ab_session"), `${userCookiesBefore.length} cookies`);

  // 2. Full broker task: capture from user browser -> agent browser -> verify.
  const cfg = {
    port: TEST_PORT,
    capture: { enabled: true },
    whitelist: { hosts: [`127.0.0.1:${SITE_PORT}`], captureLocalStorage: false },
    writeback: { enabled: true, confirm: false },
  };

  const taskResult = await runTask(async (agent) => {
    const page = await agent.page(`${origin}/`);
    const state = await page.textContent("#state");
    check("agent browser is logged in without any login action", state === "AUTHED", `state=${state}`);
    await page.close();

    // Visit a brand-new site: this cookie must be written back.
    const p2 = await agent.page(`${origin}/newsite`);
    await p2.waitForSelector("body");
    await p2.close();
  }, { config: cfg, hosts: [`127.0.0.1:${SITE_PORT}`] });

  check("broker task completed", taskResult.ok, taskResult.error || "");
  if (taskResult.writeback) {
    const { written, summary } = taskResult.writeback;
    const extra = summary.find((s) => s.host.includes("127.0.0.1"));
    check("new cookie written back to user browser", written > 0, `written=${written} summary=${JSON.stringify(summary)}`);
    check("write-back did not rotate the user's session", !summary.some((s) => s.refreshed > 0), "refreshed=0 expected");
  }

  // 3. User's original session still valid, and the extra cookie arrived.
  await up.reload({ waitUntil: "domcontentloaded" });
  const userState = await up.textContent("#state");
  check("user session still valid after write-back", userState === "AUTHED", `state=${userState}`);
  const userCookiesAfter = await userCtx.cookies();
  check("extra cookie present in user browser", userCookiesAfter.some((c) => c.name === "ab_extra"));

  // 4. Rotation guard: if the agent rotates the session, the user's newer-or-equal
  //    cookie must NOT be overwritten.
  const rotateResult = await runTask(async (agent) => {
    const p = await agent.page(`${origin}/refresh`);
    await p.waitForSelector("body");
    await p.close();
  }, { config: cfg, hosts: [`127.0.0.1:${SITE_PORT}`] });
  await up.reload({ waitUntil: "domcontentloaded" });
  const stateAfterRotate = await up.textContent("#state");
  check("rotation did not clobber user session", stateAfterRotate === "AUTHED", `state=${stateAfterRotate}`);

  // 5. No leftover agent profiles.
  const leftovers = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("ab-agent-"));
  check("agent profile wiped", leftovers.length === 0, leftovers.join(",") || "clean");

  await userCtx.close();
  server.close();
  fs.rmSync(userDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(1);
});
