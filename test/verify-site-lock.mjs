// Site borrow lock: exclusive per-site, cross-process, stale-holder takeover.
// The lock's honest scope is "our processes only" — it cannot see the user.
import { acquireSiteLock, releaseSiteLock, borrowedSites } from "../src/site-lock.js";
import { IdentityBridge } from "../src/bridge.js";
import { runTask } from "../src/broker.js";
import { spawn } from "node:child_process";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
}

const A = "borrow-a.test";
const B = "borrow-b.test";

// 1. plain acquire / conflict
const first = acquireSiteLock([A], { task: "t1" });
check("acquire takes the lock", first.ok === true);
const second = acquireSiteLock([A, B], { task: "t2" });
check("second acquire on the same site conflicts",
  second.ok === false && second.conflicts?.[0]?.host === A,
  JSON.stringify(second.conflicts || {}).slice(0, 120));
check("conflict names the holder task", second.conflicts?.[0]?.holder?.task === "t1");

// 2. other sites are unaffected while A is held
const third = acquireSiteLock([B], { task: "t3" });
check("a different site is still borrowable", third.ok === true);
releaseSiteLock(third.token);

// 3. borrowedSites reports held sites (and the bridge status surface shows it)
const held = borrowedSites().map((s) => s.host);
check("borrowedSites lists the held site", held.includes(A), held.join(","));
const bridge = new IdentityBridge({ port: 8797 });
await bridge.start();
check("bridge status carries borrowedSites",
  bridge.status().borrowedSites.some((s) => s.host === A));
await bridge.stop();

// 4. dead holder: takeover
const dead = acquireSiteLock([B]);
// simulate a dead holder by rewriting the lock file with an impossible pid
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const lockDir = path.join(os.tmpdir(), "agent-browser-locks");
const key = crypto.createHash("sha1").update(B).digest("hex").slice(0, 20);
releaseSiteLock(dead.token);
fs.writeFileSync(path.join(lockDir, key + ".lock"),
  JSON.stringify({ id: "dead", pid: 999999999, task: "ghost", hosts: [B], at: Date.now() - 60000 }));
const takeover = acquireSiteLock([B], { task: "t4" });
check("dead holder is taken over", takeover.ok === true,
  takeover.ok ? "" : JSON.stringify(takeover.conflicts || {}).slice(0, 120));

// 5. release frees the site
releaseSiteLock(first.token);
releaseSiteLock(takeover.token);
check("release frees the site", !borrowedSites().some((s) => s.host === A || s.host === B));

// 6. runTask refuses to start while the site is borrowed by a live process
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const hijack = acquireSiteLock(["github.com"], { task: "other-agent" });
check("fixture: foreign live holder took github.com", hijack.ok === true);
const refused = await runTask(async () => {}, {
  hosts: ["github.com"],
  config: { port: 9222, bridge: { enabled: false }, writeback: { enabled: false } },
});
check("runTask refuses a borrowed site",
  refused.ok === false && /already borrowed/.test(refused.error || ""),
  (refused.error || "").slice(0, 140));
releaseSiteLock(hijack.token);
holder.kill();
const afterRun = await runTask(async () => { throw new Error("should not get here either"); }, {
  hosts: ["github.com"],
  config: { port: 9222, capture: { enabled: true }, bridge: { enabled: false }, writeback: { enabled: false } },
});
check("runTask proceeds past the lock when free",
  afterRun.ok === false && !/already borrowed/.test(afterRun.error || ""),
  (afterRun.error || "").slice(0, 90));

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
