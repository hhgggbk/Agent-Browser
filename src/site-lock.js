// Site borrow lock: one agent session per site at a time, so "double open"
// becomes a scheduling decision instead of an accident.
//
// Scope, stated honestly: this coordinates OUR processes only (files under
// %TEMP%). It cannot see when the user is personally using the site — the
// policy "while an agent task runs, stay off that site yourself" lives with
// the user, and the status surfaces make it visible.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const LOCK_DIR = path.join(os.tmpdir(), "agent-browser-locks");

function normHost(h) {
  return String(h).replace(/^\./, "").replace(/:\d+$/, "").toLowerCase();
}

function lockPath(host) {
  const key = crypto.createHash("sha1").update(normHost(host)).digest("hex").slice(0, 20);
  return path.join(LOCK_DIR, key + ".lock");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours to signal — still alive
  }
}

function readHolder(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof j?.pid === "number" && Array.isArray(j.hosts)) return j;
  } catch {}
  return null;
}

export function acquireSiteLock(hosts, { task = "task" } = {}) {
  const wanted = [...new Set((hosts || []).map(normHost).filter(Boolean))];
  if (!wanted.length) return { ok: true, token: { id: null, hosts: [] } };
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  const token = {
    id: crypto.randomUUID(),
    pid: process.pid,
    task,
    hosts: wanted,
    at: Date.now(),
  };
  const taken = [];
  for (const h of wanted) {
    const file = lockPath(h);
    let fd;
    try {
      fd = fs.openSync(file, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = readHolder(file);
      if (holder && pidAlive(holder.pid)) {
        for (const t of taken) {
          try { fs.rmSync(lockPath(t), { force: true }); } catch {}
        }
        return { ok: false, conflicts: [{ host: h, holder }] };
      }
      // Dead holder (or unparsable): take over. Two live processes racing for
      // the takeover can both pass this read — accepted, single-user machine.
      try {
        fs.writeFileSync(file, JSON.stringify(token));
      } catch {}
      taken.push(h);
      continue;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(token));
    } finally {
      fs.closeSync(fd);
    }
    taken.push(h);
  }
  return { ok: true, token };
}

export function releaseSiteLock(token) {
  if (!token?.id) return;
  for (const h of token.hosts || []) {
    const file = lockPath(h);
    const holder = readHolder(file);
    if (holder && holder.id === token.id) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
}

// For status surfaces: locks whose holder process is still alive.
export function borrowedSites() {
  let entries = [];
  try {
    entries = fs.readdirSync(LOCK_DIR).filter((f) => f.endsWith(".lock"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of entries) {
    const holder = readHolder(path.join(LOCK_DIR, f));
    if (holder && pidAlive(holder.pid)) out.push(...holder.hosts.map((h) => ({
      host: h,
      pid: holder.pid,
      task: holder.task,
      since: new Date(holder.at).toISOString(),
    })));
  }
  return out;
}
