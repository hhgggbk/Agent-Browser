// Extension management through chrome.management, in a throwaway browser.
//
// Every assertion is on observed state (a fresh list), not on what the API
// returned, because "requested" and "done" are different things here.
import { AgentBrowser } from "../src/agent-browser.js";
import { IdentityBridge } from "../src/bridge.js";
import { ExtensionManager } from "../src/extensions.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? ` — ${detail}` : ""));
};

const copy = (src, tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ab-extmgr-${tag}-`));
  for (const f of ["manifest.json", "background.js", "probe.html", "probe.js"]) {
    fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  return dir;
};

const ext = copy(path.join(process.cwd(), "cookie-extension"), "bridge");
// A second, trivial unpacked extension so there is something else to disable,
// reload and remove without touching the thing doing the talking.
const victim = copy(path.join(process.cwd(), "cookie-extension"), "victim");
const vm = JSON.parse(fs.readFileSync(path.join(victim, "manifest.json"), "utf8"));
vm.name = "Extension Manager Test Subject";
vm.description = "throwaway target for management tests";
fs.writeFileSync(path.join(victim, "manifest.json"), JSON.stringify(vm, null, 2));

const bridge = new IdentityBridge({ port: 8951, extensionDir: ext });
await bridge.start();
const agent = new AgentBrowser({ headless: true, extensions: [ext, victim] });
let mgr = null;

try {
  await agent.start();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !bridge.connected) await new Promise((r) => setTimeout(r, 200));
  check("bridge extension connected", bridge.connected);
  mgr = new ExtensionManager(bridge);

  const all = await mgr.list();
  check("list returns every extension", all.length >= 2, all.map((x) => `${x.name}[${x.enabled ? "on" : "off"}]`).join(", ").slice(0, 160));
  const subject = await mgr.find("Extension Manager Test Subject");
  check("find by name", Boolean(subject && subject.id), subject && subject.id);

  const d = await mgr.detail(subject.id);
  check("detail carries permissions and installType", Array.isArray(d.permissions) && d.installType === "development",
    `installType=${d.installType} perms=${(d.permissions || []).join(",")}`);

  const off = await mgr.setEnabled(subject.id, false);
  let now = (await mgr.list()).find((x) => x.id === subject.id);
  check("disable takes effect", off.enabled === false && now && now.enabled === false, `api=${off.enabled} list=${now && now.enabled}`);

  const on = await mgr.setEnabled(subject.id, true);
  now = (await mgr.list()).find((x) => x.id === subject.id);
  check("enable takes effect", on.enabled === true && now && now.enabled === true, `api=${on.enabled} list=${now && now.enabled}`);

  const same = await mgr.setEnabled(subject.id, true);
  check("setting the current state is reported as unchanged", same.unchanged === true, JSON.stringify(same));

  const rl = await mgr.reload(subject.id);
  now = (await mgr.list()).find((x) => x.id === subject.id);
  check("reload leaves the extension present and enabled, and says how",
    rl.reloaded === true && now && now.enabled === true && Boolean(rl.how),
    `how=${rl.how} reread=${rl.rereadFromDisk} list=${now ? `${now.name}:${now.enabled}` : "(gone)"}`);

  // Rails: the bridge must not be able to take itself down.
  const selfId = (await mgr.find("Agent Browser Identity Bridge")).id;
  let selfErr = null;
  try { await mgr.uninstall(selfId); } catch (e) { selfErr = e; }
  check("refuses to uninstall itself", Boolean(selfErr) && /refus/i.test(selfErr.message), selfErr && selfErr.message.slice(0, 80));
  let selfDisable = null;
  try { await mgr.setEnabled(selfId, false); } catch (e) { selfDisable = e; }
  check("refuses to disable itself", Boolean(selfDisable), selfDisable && selfDisable.message.slice(0, 80));

  const un = await mgr.uninstall(subject.id);
  const after = await mgr.list();
  const stillListed = after.some((x) => x.id === subject.id);
  const honest = un.gone ? !stillListed : (un.outcome === "refused" || un.requiresUserConfirm === true);
  check("uninstall either removes it for real or says it needs the user",
    honest && un.gone === !stillListed,
    `gone=${un.gone} listed=${stillListed} outcome=${un.outcome} confirm=${un.requiresUserConfirm} err=${un.error ? un.error.slice(0, 60) : "-"}`);

  let loadErr = null;
  try { await mgr.loadUnpacked(victim); } catch (e) { loadErr = e; }
  const canDevPrivate = !loadErr || !/developerPrivate/.test(loadErr.message);
  check("loadUnpacked either works or says exactly why not",
    canDevPrivate || /needs chrome\.developerPrivate/.test(loadErr.message),
    loadErr ? loadErr.message.slice(0, 110) : "accepted");

  let unknown = null;
  try { await mgr.detail("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); } catch (e) { unknown = e; }
  check("an unknown id is a readable error", Boolean(unknown) && /no extension matches/.test(unknown.message), unknown && unknown.message.slice(0, 70));
} catch (e) {
  check("no exception", false, String(e.message).slice(0, 200));
} finally {
  await agent.close().catch(() => {});
  await bridge.stop().catch(() => {});
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(victim, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
