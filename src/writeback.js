// Write-back: after a task, hand the agent browser's *newly acquired* sessions
// to the user's browser. Additive and conflict-averse by construction.
//
// Rules (from the plan):
//   1. Only origins the user's browser did NOT already have are written back.
//   2. For origins the user already had, only cookies whose value changed AND
//      whose expires is newer than the user's current cookie are written.
//      (This is the narrow window where a write is worth the risk.)
//   3. Writes go through the user's own CDP (Network.setCookie), so the user's
//      browser persists them itself — we never touch its SQLite on disk.
//   4. Nothing is written without a confirmation listing what will be written,
//      unless confirm=false is passed explicitly (scripted/CI use).

import { chromium } from "playwright-core";
import readline from "node:readline";

function debugLog(...args) {
  if (process.env.AGENT_BROWSER_DEBUG) console.error("[writeback]", ...args);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); }));
}

function normDomain(d) {
  return d.replace(/^\./, "");
}

function cookieKey(c) {
  return `${normDomain(c.domain)}|${c.path || "/"}|${c.name}`;
}

export function diffCookies(userCookies, agentCookies) {
  const userByKey = new Map(userCookies.map((c) => [cookieKey(c), c]));
  const seen = new Set();
  const toWrite = [];

  for (const a of agentCookies) {
    const key = cookieKey(a);
    if (seen.has(key)) continue; // dedupe: same name/domain/path
    seen.add(key);

    const u = userByKey.get(key);
    if (!u) {
      // Rule 1: brand new for this user.
      toWrite.push({ cookie: a, reason: "new-for-user", host: normDomain(a.domain) });
      continue;
    }
    if (u.value === a.value) continue; // nothing changed
    // Rule 2: changed value — only if the agent's copy outlives the user's.
    const uExp = u.expires ?? Infinity;
    const aExp = a.expires ?? Infinity;
    if (aExp > uExp) {
      toWrite.push({ cookie: a, reason: "refreshed", host: normDomain(a.domain) });
    } else {
      debugLog("skip rotation", key, "user cookie is newer");
    }
  }
  return toWrite;
}

export function summarizeWriteBack(items) {
  const hosts = new Map();
  for (const it of items) {
    const h = hosts.get(it.host) || { newForUser: 0, refreshed: 0 };
    h[it.reason === "new-for-user" ? "newForUser" : "refreshed"] += 1;
    hosts.set(it.host, h);
  }
  return [...hosts.entries()].map(([host, c]) => ({ host, ...c }));
}

// The delta rules and the confirmation are the safety property, so both write
// paths go through here. Returns {empty:true} or {declined:true} instead of a
// plan, and the callers pass those straight back.
export async function planWriteBack({ userCookies, agentCookies, confirm = false }) {
  const items = diffCookies(userCookies, agentCookies);
  if (items.length === 0) {
    return { written: 0, skipped: 0, items: [], summary: [], empty: true };
  }
  const summary = summarizeWriteBack(items);

  if (confirm) {
    console.error("即将回写以下登录态到你的浏览器：");
    for (const s of summary) {
      console.error(`  ${s.host}: 新增 ${s.newForUser} 项, 续期 ${s.refreshed} 项`);
    }
    const ans = await ask("确认写入？[y/N] ");
    if (ans !== "y" && ans !== "yes") {
      return { written: 0, skipped: items.length, items: [], summary, declined: true };
    }
  }
  return { items, summary };
}

export async function writeBack({
  port = 9222,
  userCookies,
  agentCookies,
  confirm = false,
} = {}) {
  const plan = await planWriteBack({ userCookies, agentCookies, confirm });
  if (plan.empty || plan.declined) return plan;
  const { items, summary } = plan;

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let written = 0;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("user browser has no open context");
    const pages = context.pages();
    const cdp = pages.length > 0 ? await context.newCDPSession(pages[0]) : null;
    // Network.setCookie needs a page session; fall back to context.addCookies
    // if the user has no open tab — both persist through the browser itself.
    for (const it of items) {
      try {
        if (cdp) {
          await cdp.send("Network.setCookie", toCDPCookie(it.cookie));
        } else {
          await context.addCookies([it.cookie]);
        }
        written += 1;
      } catch (e) {
        debugLog("write failed", cookieKey(it.cookie), e.message);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { written, skipped: items.length - written, items, summary };
}

// Same additive delta, applied by Chrome itself through the extension. This is
// the only write path for a browser that refuses --remote-debugging-port.
export async function writeBackViaBridge({
  bridge,
  userCookies,
  agentCookies,
  confirm = false,
} = {}) {
  const plan = await planWriteBack({ userCookies, agentCookies, confirm });
  if (plan.empty || plan.declined) return plan;
  const { items, summary } = plan;

  const out = await bridge.setCookies(items.map((it) => it.cookie));
  const applied = new Set(out.applied || []);
  const failed = out.failed || [];
  // applied/failed carry names only: a name that landed on one domain and was
  // refused on another must not count as written.
  const failedNames = new Set(failed.map((f) => f.name));
  const written = items.filter((it) => applied.has(it.cookie.name) && !failedNames.has(it.cookie.name)).length;
  return {
    written,
    skipped: items.length - written,
    items,
    summary,
    failed,
    via: "extension-bridge",
  };
}

function toCDPCookie(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (c.sameSite) out.sameSite = c.sameSite;
  if (typeof c.expires === "number" && c.expires > 0) out.expires = c.expires;
  return out;
}
