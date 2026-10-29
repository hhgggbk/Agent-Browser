// Path-level禁区 guard: the agent may reuse the user's session, but it must
// never land on a page that spends money, rotates credentials, verifies an
// identity, or deletes an account — not even by accident after a redirect.
//
// Why this is a hard block and not a prompt instruction: the whole point of the
// runtime is that nobody watches each navigation. A rule that only fires when
// the caller remembers to ask is a rule that fires never.
//
// Matching is deliberately dumb: case-folded glob against the URL's path
// (+ query), where `*` matches anything including "/" and `?` matches one
// character. Every other character is escaped, so a rule never silently turns
// into a regex. Host-scoped rules take the object form { host, path }.

export const DEFAULT_DENIED = [
  // --- payment / money movement
  { category: "payment", path: "*/pay" },
  { category: "payment", path: "*/pay/*" },
  { category: "payment", path: "*/pay?" },
  { category: "payment", path: "*payment*" },
  { category: "payment", path: "*checkout*" },
  { category: "payment", path: "*cashier*" },
  { category: "payment", path: "*billing*" },
  { category: "payment", path: "*invoice*" },
  { category: "payment", path: "*recharge*" },
  { category: "payment", path: "*top-up*" },
  { category: "payment", path: "*topup*" },
  { category: "payment", path: "*subscription*" },
  { category: "payment", path: "*/withdraw*" },
  { category: "payment", path: "*/refund*" },
  { category: "payment", path: "*alipay*" },
  { category: "payment", path: "*wxpay*" },
  { category: "payment", path: "*wechatpay*" },
  { category: "payment", path: "*paypal*" },
  { category: "payment", path: "*/bind-card*" },
  { category: "payment", path: "*/card/bind*" },
  { category: "payment", path: "*/支付*" },
  { category: "payment", path: "*/付款*" },
  { category: "payment", path: "*/提现*" },
  { category: "payment", path: "*/充值*" },

  // --- account security / credentials / sessions
  { category: "security", path: "*password*" },
  { category: "security", path: "*passwd*" },
  { category: "security", path: "*token*" },
  { category: "security", path: "*api-key*" },
  { category: "security", path: "*api_key*" },
  { category: "security", path: "*apikey*" },
  { category: "security", path: "*ssh-key*" },
  { category: "security", path: "*ssh_key*" },
  { category: "security", path: "*oauth*" },
  { category: "security", path: "*/authorize*" },
  { category: "security", path: "*/settings/security*" },
  { category: "security", path: "*/account/security*" },
  { category: "security", path: "*/security/settings*" },
  { category: "security", path: "*two-factor*" },
  { category: "security", path: "*2fa*" },
  { category: "security", path: "*recovery-code*" },
  { category: "security", path: "*/sessions*" },
  { category: "security", path: "*/logout*" },
  { category: "security", path: "*/log_out*" },
  { category: "security", path: "*/signout*" },
  { category: "security", path: "*/applications*" },
  { category: "security", path: "*/密码*" },

  // --- real-name / KYC / identity verification
  { category: "kyc", path: "*kyc*" },
  { category: "kyc", path: "*real-name*" },
  { category: "kyc", path: "*realname*" },
  { category: "kyc", path: "*shiming*" },
  { category: "kyc", path: "*identity-verif*" },
  { category: "kyc", path: "*verify-identity*" },
  { category: "kyc", path: "*certification*" },
  { category: "kyc", path: "*renzheng*" },
  { category: "kyc", path: "*/verify/*" },
  { category: "kyc", path: "*/verify?" },
  { category: "kyc", path: "*/verify" },
  { category: "kyc", path: "*/实名*" },
  { category: "kyc", path: "*/认证*" },

  // --- account deletion / deactivation
  { category: "deletion", path: "*delete-account*" },
  { category: "deletion", path: "*delete_account*" },
  { category: "deletion", path: "*/account/delete*" },
  { category: "deletion", path: "*deactivate*" },
  { category: "deletion", path: "*close-account*" },
  { category: "deletion", path: "*/deletion*" },
  { category: "deletion", path: "*/注销*" },
  { category: "deletion", path: "*/删除账号*" },
];

const compiled = new Map();

function compile(glob) {
  const hit = compiled.get(glob);
  if (hit) return hit;
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  const rx = new RegExp(re + "$", "i");
  compiled.set(glob, rx);
  return rx;
}

function normalize(rule) {
  if (typeof rule === "string") return { category: "custom", path: rule };
  return {
    category: rule.category || "custom",
    path: rule.path || rule.pattern || "",
    host: rule.host || null,
    note: rule.note || null,
  };
}

function hostMatches(pattern, hostWithPort) {
  const want = String(pattern).replace(/^\./, "").toLowerCase();
  const have = hostWithPort.toLowerCase();
  return have === want || have.endsWith("." + want);
}

// Paths the guard tests per URL. The query string is included so a rule with a
// trailing wildcard cannot be dodged by "?x=1"; a hash *route* is included
// because hash-routed SPAs keep the pathname at "/" and put the real route in
// "#/pay/..." — a plain anchor ("#password" on a docs page) is deliberately not
// treated as a route; and a percent-encoded Chinese segment is matched both raw
// and decoded.
function candidates(u) {
  const out = [u.pathname, u.pathname + u.search];
  const route = u.hash.startsWith("#/") || u.hash.startsWith("#!/");
  if (route) out.push(u.pathname + u.search + u.hash, u.pathname + u.hash, u.hash.slice(1));
  try {
    const dec = decodeURIComponent(u.pathname);
    if (dec !== u.pathname) out.push(dec, dec + u.search);
  } catch {}
  return out;
}

export function guardFromConfig(guardCfg = {}) {
  if (guardCfg.enabled === false) return { enabled: false, denied: [], allow: [] };
  return {
    enabled: true,
    denied: [...DEFAULT_DENIED, ...(guardCfg.extraDenied || [])],
    allow: guardCfg.allow || [],
  };
}

export function parseUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

// Returns null when the URL is fine, otherwise the rule that caught it.
export function findViolation(url, { denied = DEFAULT_DENIED, allow = [] } = {}) {
  const u = parseUrl(url);
  if (!u) return null; // about:/data:/file: — no site session to spend there
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const paths = candidates(u);
  for (const raw of denied) {
    const rule = normalize(raw);
    if (!rule.path) continue;
    if (rule.host && !hostMatches(rule.host, host)) continue;
    if (!paths.some((p) => compile(rule.path).test(p))) continue;
    // A later rule still gets to block: exceptions narrow, they do not blanket.
    const excepted = allow.some((a) => {
      const r = normalize(a);
      if (!r.path) return false;
      if (r.host && !hostMatches(r.host, host)) return false;
      return paths.some((p) => compile(r.path).test(p));
    });
    if (excepted) continue;
    return { rule, url: String(url), host };
  }
  return null;
}

export class GuardViolation extends Error {
  constructor(found) {
    const r = found.rule;
    super(
      `guard: 禁止进入「${r.category}」类页面 — 命中规则 ${r.path}` +
        (r.host ? ` @${r.host}` : "") + `\n  url: ${found.url}` +
        (r.note ? `\n  note: ${r.note}` : "") +
        `\n  agent 可以读写内容与数据，但支付/账号安全/实名/注销这四类页面永远不进。` +
        `\n  确实需要放行某条路径时，在 config 的 guard.allow 里加一条更精确的规则。`,
    );
    this.name = "GuardViolation";
    this.guard = r;
    this.url = found.url;
  }
}

// Throws GuardViolation. Called before goto, again on the final URL, and by the
// framenavigated watcher for in-page navigation.
export function assertGuard(url, opts = {}) {
  if (opts.enabled === false) return null;
  const found = findViolation(url, opts);
  if (found) throw new GuardViolation(found);
  return null;
}
