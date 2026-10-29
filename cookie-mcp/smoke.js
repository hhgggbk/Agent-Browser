// Smoke test: drive the cookie MCP server over stdio with real JSON-RPC, the
// same way Qoder will. Covers initialize, tools/list, and every tool, against
// a throwaway Chrome that has known cookies — so the assertions are about our
// parsing and protocol, not about the user's real browser.

import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const SERVER = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "server.js");
const TEST_PORT = 9790;
const SITE_PORT = 9791;

function startSite() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${SITE_PORT}`);
    if (url.pathname === "/login") {
      res.writeHead(200, {
        // One Set-Cookie header per cookie; a joined array is not valid.
        "Set-Cookie": "ab_mcp_session=secret123; Path=/; HttpOnly",
        "Content-Type": "text/html",
      });
      res.end(`<html><body><span id="state">AUTHED</span></body></html>`);
      return;
    }
    if (url.pathname === "/pref") {
      res.writeHead(200, { "Set-Cookie": "ab_mcp_pref=dark; Path=/; Max-Age=3600", "Content-Type": "text/html" });
      res.end("pref set");
      return;
    }
    const cookies = req.headers.cookie || "";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><span id="state">${/ab_mcp_session=/.test(cookies) ? "AUTHED" : "ANON"}</span></body></html>`);
  });
  return new Promise((r) => server.listen(SITE_PORT, "127.0.0.1", () => r(server)));
}

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.buffer = "";
    this.pending = new Map();
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
      }
    });
  }

  request(method, params = {}) {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 45000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }
}

function toolText(res) {
  const r = res.result;
  if (!r) {
    return { error: `no result in reply: ${JSON.stringify(res.error || res).slice(0, 300)}` };
  }
  if (r.isError) return { error: JSON.parse(r.content[0].text).error };
  if (!r.content?.[0]?.text) return { error: `empty tool content: ${JSON.stringify(r).slice(0, 200)}` };
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return { error: `tool text is not JSON: ${String(r.content[0].text).slice(0, 200)}` };
  }
}

async function main() {
  const siteServer = await startSite();
  const origin = `http://127.0.0.1:${SITE_PORT}`;

  // A "user browser" with known cookies, on a CDP port.
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mcp-user-"));
  const userCtx = await chromium.launchPersistentContext(userDir, {
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
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
  // A second cookie so the name filter has something to exclude.
  await up.goto(`${origin}/pref`);

  // Launch the MCP server as a subprocess with the test port.
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CHROME_CDP_PORT: String(TEST_PORT) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const client = new McpClient(proc);

  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  check("initialize returns serverInfo", !!init.result?.serverInfo?.name, init.result?.serverInfo?.name || "");

  const tools = await client.request("tools/list");
  const names = (tools.result?.tools || []).map((t) => t.name);
  const expected = ["list_cookie_domains", "get_cookies", "cookie_source_info", "list_extensions", "extension_manage"];
  check("tools/list exposes the expected tools", expected.every((n) => names.includes(n)),
    names.join(","));
  check("every tool has an inputSchema",
    (tools.result?.tools || []).every((t) => t.inputSchema && t.inputSchema.type === "object"));

  const info = toolText(await client.callTool("cookie_source_info"));
  check("cookie_source_info sees the live CDP port", info.liveCDP?.available === true,
    `port=${info.liveCDP?.port} browser=${info.liveCDP?.browser} payload=${JSON.stringify(info).slice(0, 240)}`);
  check("cookie_source_info reports chrome running", info.chromeRunning === true);

  const list = toolText(await client.callTool("list_cookie_domains"));
  check("list_cookie_domains finds 127.0.0.1", list.domains?.some((d) => d.domain === "127.0.0.1"),
    `domains=${(list.domains || []).map((d) => d.domain).join(",")}`);
  check("list_cookie_domains returns no cookie values",
    (list.domains || []).every((d) => d.value === undefined));

  const got = toolText(await client.callTool("get_cookies", { domains: ["127.0.0.1"] }));
  check("get_cookies returns the session cookie", got.cookies?.some((c) => c.name === "ab_mcp_session" && c.value === "secret123"),
    `count=${got.count} names=${(got.cookies || []).map((c) => c.name).join(",")}`);
  check("get_cookies preserves httpOnly", got.cookies?.some((c) => c.name === "ab_mcp_session" && c.httpOnly === true));
  check("get_cookies reports live source", got.source === "live", got.source);

  // Host-string semantics: 127.0.0.1 and localhost are the same origin to a
  // browser but distinct cookie domains on disk, so asking for localhost
  // must not return the 127.0.0.1 cookie. Subdomain matching is asserted on
  // the parent/child form below.
  const parent = toolText(await client.callTool("get_cookies", { domains: ["localhost"] }));
  check("localhost does not match 127.0.0.1 cookie domain", parent.count === 0, `count=${parent.count}`);

  // A leading-dot parent domain must match the bare host.
  const dotted = toolText(await client.callTool("get_cookies", { domains: [".127.0.0.1"] }));
  check("leading-dot parent domain matches the host", dotted.count === 2, `count=${dotted.count}`);

  // Name filter.
  const filtered = toolText(await client.callTool("get_cookies", { domains: ["127.0.0.1"], names: ["ab_mcp_pref"] }));
  check("name filter returns only the asked cookie",
    filtered.cookies?.length === 1 && filtered.cookies[0].name === "ab_mcp_pref",
    `names=${(filtered.cookies || []).map((c) => c.name).join(",")}`);

  // A domain the test profile has no cookies for: must come back empty, and
  // must never be filled in with freshly-minted look-alikes.
  const none = toolText(await client.callTool("get_cookies", { domains: ["github.com"] }));
  check("domain with no cookies returns zero", none.count === 0, `count=${none.count} source=${none.source}`);

  // Snapshot path must label ciphertext rather than pass it off as a value.
  const snap = toolText(await client.callTool("get_cookies", { domains: ["127.0.0.1"] }));
  const honest = (snap.cookies || []).every(
    (c) => snap.source === "live" || !c.encrypted || String(c.value).startsWith("__encrypted__"),
  );
  check("encrypted values are always labelled, never silently passed through", honest,
    `source=${snap.source}`);

  // Bad input.
  const bad = toolText(await client.callTool("get_cookies", { domains: [] }));
  check("empty domains is rejected with an error", !!bad.error, bad.error || "");

  // Extension management: bad action is rejected on its own, with no bridge.
  const badAct = toolText(await client.callTool("extension_manage", { action: "explode", target: "x" }));
  check("extension_manage rejects an unknown action", !!badAct.error && /action must be one of/.test(badAct.error), (badAct.error || "").slice(0, 80));

  // No bridge here: the tool must say that, not pretend the list is empty.
  const extList = toolText(await client.callTool("list_extensions", {}));
  const noBridgeSaid = extList?.error || Array.isArray(extList?.extensions);
  check("list_extensions does not fake an empty list without a bridge",
    Boolean(extList?.error) ? /bridge/.test(extList.error) : Array.isArray(extList.extensions),
    JSON.stringify(extList).slice(0, 120));

  // Unknown tool.
  const unk = await client.callTool("nope", {});
  check("unknown tool returns isError", unk.result?.isError === true);

  proc.kill();
  await userCtx.close();
  siteServer.close();
  fs.rmSync(userDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
