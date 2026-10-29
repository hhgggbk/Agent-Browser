// Real-machine silence check: launches a real agent browser on this machine,
// then enumerates processes and top-level windows to prove the taskbar and
// Alt+Tab stay clean, and that nothing is left on disk afterwards.
//
// This is the check the functional tests could not do: it inspects the OS
// process/window tables, not the browser's own state.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTask } from "../src/broker.js";
import { CHROME_EXE } from "../src/capture.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "fixtures");

// Windows: enumerate visible, taskbar-eligible top-level windows. The script
// lives in fixtures/ — inline PowerShell here would need nested escaping.
function topLevelWindows(pid = 0) {
  const script = path.join(FIX, "enum-windows.ps1");
  try {
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" ${pid}`,
      { encoding: "utf8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    return { error: e.message };
  }
}

// chrome.exe processes with their command lines. The agent browser is
// identified by its ephemeral --user-data-dir (ab-agent-*), not by parent pid:
// on Windows the browser process is re-parented to the launch process.
function chromeProcesses() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`,
      { encoding: "utf8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
    );
    const arr = JSON.parse(out.replace(/\r?\n/g, ""));
    return Array.isArray(arr) ? arr : [arr];
  } catch (e) {
    return { error: e.message };
  }
}

function agentChromeProcs() {
  const procs = chromeProcesses();
  if (!Array.isArray(procs)) return [];
  return procs.filter((p) => /ab-agent-/i.test(p.CommandLine || ""));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const sitePort = 9782;
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Set-Cookie": "ab_silent=1; Path=/", "Content-Type": "text/html" });
    res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
  });
  await new Promise((r) => server.listen(sitePort, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${sitePort}`;

  // Launch a "user browser" on a temp port so capture has something to attach to.
  const { chromium } = await import("playwright-core");
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-silent-user-"));
  const userCtx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME_EXE,
    headless: true,
    args: [
      "--remote-debugging-port=9783",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
    ],
  });
  const up = await userCtx.newPage();
  await up.goto(`${origin}/`);
  await up.waitForSelector("#state");

  const before = chromeProcesses();
  const beforeCount = Array.isArray(before) ? before.length : -1;
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("ab-agent-"));

  // Run a task that keeps the agent browser alive long enough to inspect.
  let keepOpen = true;
  const taskP = runTask(async (agent) => {
    const page = await agent.page(origin);
    const state = await page.textContent("#state");
    check("agent browser functional during silence check", state === "AUTHED", `state=${state}`);

    const agentProcs = agentChromeProcs();
    check("agent browser spawned at least one chrome process", agentProcs.length >= 1,
      `ab-agent chrome procs=${agentProcs.length}`);

    // Give the OS a moment to register the window (or its absence).
    await sleep(2500);

    const wins = topLevelWindows();
    if (Array.isArray(wins)) {
      const agentPids = new Set(agentProcs.map((p) => Number(p.ProcessId)));
      const owned = wins.filter((w) => agentPids.has(Number(w.split("|")[0])));
      check("agent browser has zero taskbar/Alt+Tab windows", owned.length === 0,
        owned.length ? owned.join(" ; ") : `pids=${[...agentPids].join(",")} 0 windows`);
    } else {
      check("window enumeration ran", false, JSON.stringify(wins));
    }

    while (keepOpen) await sleep(200);
    await page.close();
  }, {
    silent: true,
    config: {
      port: 9783,
      capture: { enabled: true },
      whitelist: { hosts: [`127.0.0.1:${sitePort}`], captureLocalStorage: false },
      writeback: { enabled: false },
    },
    hosts: [`127.0.0.1:${sitePort}`],
  });

  await sleep(6000);
  keepOpen = false;
  const res = await taskP;
  check("silence-check task completed", res.ok, res.error || "");

  // After close: no agent-owned chrome, no temp profile.
  await sleep(3000);
  const afterProcs = agentChromeProcs();
  check("agent chrome process gone after close", afterProcs.length === 0,
    afterProcs.map((p) => p.ProcessId).join(",") || "clean");

  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("ab-agent-"));
  check("no temp profile left behind", tmpAfter.length === 0, tmpAfter.join(",") || "clean");
  check("no temp cookie snapshot left behind", fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("ab-cookies-")).length === 0);

  await userCtx.close();
  server.close();
  fs.rmSync(userDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-silence crashed:", e);
  process.exit(1);
});
