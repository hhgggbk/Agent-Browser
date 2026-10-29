// HTTPS real-link verification: self-signed cert site that issues
// secure / sameSite=None / HttpOnly cookies, exercising the paths the local
// HTTP test could not: TLS transport, secure flag round-trip, and the offline
// capture fallback when the user's browser has no CDP port.

import { chromium } from "playwright-core";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTask } from "../src/broker.js";
import { CHROME_EXE } from "../src/capture.js";
import { diffCookies, summarizeWriteBack } from "../src/writeback.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const TEST_PORT = 9779;
const SITE_PORT = 9780;
const FIX = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "fixtures");

// HTTPS site. /login sets a secure, sameSite=None, HttpOnly cookie over TLS.
// /secure-check reports whether that cookie arrived. /iframe-host embeds a
// cross-origin frame (same host, different port counts as different origin for
// cookie purposes) to check third-party cookie behavior.
function startSite() {
  let n = 0;
  const handler = (req, res, secure) => {
    const url = new URL(req.url, `http://127.0.0.1:${SITE_PORT}`);
    const proto = secure ? "https" : "http";
    if (url.pathname === "/login") {
      n += 1;
      res.writeHead(200, {
        "Set-Cookie": `ab_secure=s${n}; Path=/; Secure; HttpOnly; SameSite=None`,
        "Content-Type": "text/html",
      });
      res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
      return;
    }
    if (url.pathname === "/refresh") {
      n += 1;
      res.writeHead(200, { "Set-Cookie": `ab_secure=s${n}; Path=/; Secure; HttpOnly; SameSite=None`, "Content-Type": "text/html" });
      res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
      return;
    }
    if (url.pathname === "/newsite") {
      res.writeHead(200, { "Set-Cookie": `ab_secure_extra=x1; Path=/; Secure`, "Content-Type": "text/html" });
      res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
      return;
    }
    if (url.pathname === "/iframe") {
      const frameProto = secure ? "https" : "http";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><iframe src="${frameProto}://127.0.0.1:${secure ? SITE_PORT : SITE_PORT + 1}/"></iframe></body></html>`);
      return;
    }
    const cookies = req.headers.cookie || "";
    const has = /ab_secure=/.test(cookies);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><span id="state">${has ? "AUTHED" : "ANON"}</span></body></html>`);
  };
  const httpsServer = https.createServer(
    { key: fs.readFileSync(path.join(FIX, "key.pem")), cert: fs.readFileSync(path.join(FIX, "cert.pem")) },
    (req, res) => handler(req, res, true),
  );
  const httpServer = http.createServer((req, res) => handler(req, res, false));
  return Promise.all([
    new Promise((r) => httpsServer.listen(SITE_PORT, "127.0.0.1", r)),
    new Promise((r) => httpServer.listen(SITE_PORT + 1, "127.0.0.1", r)),
  ]).then(() => ({ httpsServer, httpServer }));
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
  const { httpsServer, httpServer } = await startSite();
  const origin = `https://127.0.0.1:${SITE_PORT}`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-user2-"));

  const userCtx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME_EXE,
    headless: true,
    args: [
      `--remote-debugging-port=${TEST_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "--ignore-certificate-errors",
    ],
    ignoreHTTPSErrors: true,
  });
  const up = await userCtx.newPage();
  await up.goto(`${origin}/login`);
  await up.waitForSelector("#state");
  const userCookiesBefore = await userCtx.cookies();
  const sec = userCookiesBefore.find((c) => c.name === "ab_secure");
  check("user browser holds secure cookie over TLS", !!sec && sec.secure === true,
    sec ? `secure=${sec.secure} sameSite=${sec.sameSite} httpOnly=${sec.httpOnly}` : "missing");

  const cfg = {
    port: TEST_PORT,
    capture: { enabled: true },
    whitelist: { hosts: [`127.0.0.1:${SITE_PORT}`], captureLocalStorage: false },
    writeback: { enabled: true, confirm: false },
  };

  // 1. Restore over HTTPS: secure cookie must survive and be sent on TLS.
  const t1 = await runTask(async (agent) => {
    const page = await agent.page(`${origin}/`);
    const state = await page.textContent("#state");
    check("agent browser authenticated on HTTPS without login", state === "AUTHED", `state=${state}`);
    await page.close();

    // 2. Same-origin HTTPS iframe: the Secure cookie must reach it.
    const p2 = await agent.page(`${origin}/iframe`);
    const frameState = await p2.frameLocator("iframe").locator("#state").textContent();
    check("secure cookie sent inside same-origin HTTPS iframe", frameState === "AUTHED", `state=${frameState}`);
    await p2.close();

    // 2b. http:// on a trustworthy origin (127.0.0.1 counts as localhost) DOES
    //     receive the Secure cookie per spec — the browser allows it. This
    //     documents that behavior instead of asserting the opposite.
    const p2b = await agent.page(`http://127.0.0.1:${SITE_PORT + 1}/iframe`);
    const insecureState = await p2b.frameLocator("iframe").locator("#state").textContent();
    check("secure cookie behavior on trustworthy http origin (documented)",
      insecureState === "AUTHED", `state=${insecureState} — 127.0.0.1 is a trustworthy origin`);
    await p2b.close();

    // 3. New-site write-back over HTTPS.
    const p3 = await agent.page(`${origin}/newsite`);
    await p3.waitForSelector("#state");
    await p3.close();
  }, { config: cfg, hosts: [`127.0.0.1:${SITE_PORT}`], ignoreHTTPSErrors: true });

  check("https broker task completed", t1.ok, t1.error || "");
  const extra = t1.writeback?.summary.find((s) => s.host.includes("127.0.0.1"));
  check("https new cookie written back", (t1.writeback?.written || 0) > 0,
    `written=${t1.writeback?.written} summary=${JSON.stringify(t1.writeback?.summary)}`);

  // 4. diffCookies preserves secure/sameSite on write-back items.
  const agentCookies = [{ name: "ab_secure_extra", value: "x1", domain: "127.0.0.1", path: "/", secure: true, sameSite: "None", httpOnly: false, expires: -1 }];
  const diffed = diffCookies([], agentCookies);
  check("diff preserves cookie attributes", diffed[0]?.cookie.secure === true && diffed[0]?.cookie.sameSite === "None",
    JSON.stringify(diffed[0]?.cookie));

  // 5. Offline path: no CDP reachable. The DB itself is readable (there is no
  //    lock), so the honest answer is "readable but values are v20-encrypted".
  const { captureOffline } = await import("../src/capture.js");
  const off = await captureOffline({});
  check("offline capture reads the DB and reports v20 encryption honestly",
    off.mode === "offline" && /v20/.test(off.note || ""),
    `mode=${off.mode} note=${off.note}`);

  // 6. Rotation guard over HTTPS.
  const t2 = await runTask(async (agent) => {
    const p = await agent.page(`${origin}/refresh`);
    await p.waitForSelector("#state");
    await p.close();
  }, { config: cfg, hosts: [`127.0.0.1:${SITE_PORT}`], ignoreHTTPSErrors: true });
  await up.reload({ waitUntil: "domcontentloaded" });
  const stateAfter = await up.textContent("#state");
  check("https rotation did not clobber user session", stateAfter === "AUTHED", `state=${stateAfter}`);

  const leftovers = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("ab-agent-"));
  check("agent profile wiped", leftovers.length === 0, leftovers.join(",") || "clean");

  await userCtx.close();
  httpsServer.close();
  httpServer.close();
  fs.rmSync(userDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-https crashed:", e);
  process.exit(1);
});
