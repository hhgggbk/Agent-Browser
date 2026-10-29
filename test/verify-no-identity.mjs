// The broker must refuse to run a task when it cannot capture usable identity.
// Running anyway would produce an anonymous agent browser that looks like a
// success — the exact failure mode the profile-copy experiment demonstrated.
import { runTask } from "../src/broker.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
}

// Nothing listens on this port, so capture falls to the offline census, which
// yields metadata but no usable cookies.
const PORT_UNUSED = 9999;

let ran = false;
const res = await runTask(async () => { ran = true; }, {
  hosts: ["github.com"],
  config: {
    port: PORT_UNUSED,
    capture: { enabled: true },
    whitelist: { hosts: ["github.com"], captureLocalStorage: false },
    writeback: { enabled: false },
  },
});

check("task refuses to run without usable identity", res.ok === false && !ran,
  `ok=${res.ok} taskRan=${ran}`);
check("error names the fix", /remote-debugging-port/.test(res.error || ""),
  (res.error || "").split("\n")[0]);
check("error reports what is on disk", /cookie rows exist on disk/.test(res.error || ""),
  (res.error || "").split("\n").slice(1, 2).join("").slice(0, 90));

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
