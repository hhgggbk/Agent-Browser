// Drive a browser you already run, through the published MCP door.
//
//   set AGENT_BROWSER_CDP_URL=http://127.0.0.1:9333      (browser started with --remote-debugging-port)
//   node test/verify-attach.mjs
//
// Exercises the capabilities the skill promises: page control, snapshot/uids,
// open shadow roots, fill/click, in-page JS, wait, screenshot (inline + file),
// css cascade, network, console, performance trace, and the cookie gate.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CDP = (process.env.AGENT_BROWSER_CDP_URL || "").trim();
const WORKSPACE = (process.env.AGENT_BROWSER_WORKSPACE || os.tmpdir()).replace(/\\/g, "/");
const PORT = Number(process.env.VERIFY_PORT || 9820);

if (!CDP) {
  console.log("skip: set AGENT_BROWSER_CDP_URL to a browser started with --remote-debugging-port");
  process.exit(0);
}

const PAGE = `<!doctype html><meta charset=utf-8><title>attach-probe</title>
<h1 id="title">attach-probe</h1>
<input id="q" placeholder="type here">
<button id="go">Go</button>
<div id="out">idle</div>
<div id="host"></div>
<script>
document.getElementById('go').onclick = () => {
  document.getElementById('out').textContent = 'clicked:' + document.getElementById('q').value;
};
const r = document.getElementById('host').attachShadow({ mode: 'open' });
r.innerHTML = '<p id="s">shadow-text</p><button id="sb">shadow-btn</button>';
r.getElementById('sb').onclick = () => { document.getElementById('out').textContent = 'shadow-clicked'; };
</script>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/ping")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"pong":true}');
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const door = spawn(process.execPath, [path.join(ROOT, "src", "mcp.js")], {
  cwd: ROOT,
  env: { ...process.env, AGENT_BROWSER_CDP_URL: CDP, AGENT_BROWSER_WORKSPACE: WORKSPACE },
  stdio: ["pipe", "pipe", "pipe"],
});
let errlog = "";
door.stderr.on("data", (d) => { errlog += d; });

let nextId = 1;
const pending = new Map();
let buf = "";
door.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
function rpc(method, params, ms = 60000) {
  const id = nextId++;
  door.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ error: { message: `timeout ${ms}ms` } }); }, ms);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  });
}
const text = (r) => (r?.result?.content || []).map((c) => c.text).join("\n");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
};
async function call(name, args = {}, ms) {
  const r = await rpc("tools/call", { name, arguments: args }, ms);
  return { ok: !r.error && !r.result?.isError, text: r.error ? `RPC error: ${r.error.message}` : text(r), raw: r };
}

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-attach", version: "1" } });
check("MCP handshake", !!init.result, init.result?.serverInfo?.name || init.error?.message);
door.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const tools = (await rpc("tools/list", {})).result?.tools || [];
check("tools/list", tools.length >= 37, `${tools.length} tools`);

const target = `http://127.0.0.1:${PORT}/`;
const np = await call("new_page", { url: target }, 90000);
check("new_page reaches the browser", np.ok, np.text.split("\n")[0]);
const pages = [...(await call("list_pages", {})).text.matchAll(/^(\d+):\s+(.*)$/gm)].map((m) => ({ id: Number(m[1]), url: m[2] }));
const page = pages.find((p) => p.url.includes(`127.0.0.1:${PORT}`)) || pages[pages.length - 1];
const pageId = page?.id;
check("list_pages finds the page", !!pageId, `pageId=${pageId}`);

const ua = await call("evaluate_script", { pageId, function: "() => navigator.userAgent" });
check("evaluate_script (isolated world)", ua.ok, ua.text.slice(0, 100));

const snap = await call("take_snapshot", { pageId });
const uidOf = (kind) => (snap.text.match(new RegExp(`uid=(\\S+)\\s+${kind}`)) || [])[1];
const uidInput = uidOf("textbox");
const uidButton = uidOf("button");
check("take_snapshot yields uids", !!uidInput && !!uidButton, `textbox=${uidInput} button=${uidButton}`);
check("snapshot pierces open shadow root", snap.text.includes("shadow-text"), "");

const css = await call("get_css_styles", { pageId, uid: uidButton });
check("get_css_styles", css.ok && css.text.length > 50, `${css.text.length} chars`);

check("fill", (await call("fill", { pageId, uid: uidInput, value: "hello" })).ok, "");
check("click", (await call("click", { pageId, uid: uidButton })).ok, "");
const out = await call("evaluate_script", { pageId, function: "() => document.querySelector('#out').textContent" });
check("fill + click actually landed", out.text.includes("clicked:hello"), out.text.slice(0, 60));

const jsShadow = await call("evaluate_script", {
  pageId,
  function: "() => { document.getElementById('host').shadowRoot.querySelector('#sb').click(); return document.querySelector('#out').textContent; }",
});
check("page JS through open shadow root", jsShadow.text.includes("shadow-clicked"), "");
check("wait_for text", (await call("wait_for", { pageId, text: ["shadow-clicked"], timeout: 5000 })).ok, "");

const shot = await call("take_screenshot", { pageId });
const img = (shot.raw?.result?.content || []).find((c) => c.type === "image");
check("take_screenshot inline image", shot.ok && (img?.data || "").length > 5000, `base64=${(img?.data || "").length}`);
const shotPath = `${WORKSPACE}/_verify_attach.png`.replace(/\/+/g, "/");
fs.rmSync(shotPath, { force: true });
const shotFile = await call("take_screenshot", { pageId, filePath: shotPath }, 25000);
check("take_screenshot to file", shotFile.ok && fs.existsSync(shotPath), shotFile.ok ? `bytes=${fs.statSync(shotPath).size}` : shotFile.text.slice(0, 120));

await call("evaluate_script", { pageId, function: "() => fetch('/api/ping?t=' + Date.now()).then(r => r.status)" });
await new Promise((r) => setTimeout(r, 600));
const net = await call("list_network_requests", { pageId });
check("list_network_requests", net.ok && /api\/ping/.test(net.text), "");
check("list_console_messages", (await call("list_console_messages", { pageId })).ok, "");

const start = await call("performance_start_trace", { pageId, reload: true, autoStop: false }, 90000);
const stop = start.ok ? await call("performance_stop_trace", { pageId }, 120000) : { ok: false, text: "skipped" };
check("performance trace start+stop", start.ok && stop.ok && !/Error/i.test(stop.text), "");

check("cookie_source_info answers", (await call("cookie_source_info", {})).ok, "");
const ck = await call("get_cookies", { domains: ["example.com"] });
check("get_cookies gate is closed by default", /off by default|COOKIE_ACCESS_DISABLED|ALLOW_COOKIE_ACCESS/i.test(ck.text), "");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
if (failed.length && errlog.trim()) console.log(errlog.trim().split("\n").slice(-10).join("\n"));

door.kill();
server.close();
process.exit(failed.length ? 1 : 0);
