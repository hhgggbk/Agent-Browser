// Vault: holds captured identity in memory only. Task-scoped, TTL'd, never on disk.

import crypto from "node:crypto";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class IdentityVault {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map(); // key -> { cookies, storages, createdAt, expiresAt }
  }

  static key(scope = "default") {
    return crypto.createHash("sha256").update(scope).digest("hex").slice(0, 16);
  }

  put(scope, { cookies = [], storages = [] } = {}) {
    const now = Date.now();
    const entry = {
      scope,
      cookies,
      storages,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.entries.set(IdentityVault.key(scope), entry);
    return entry;
  }

  get(scope) {
    const entry = this.entries.get(IdentityVault.key(scope));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(IdentityVault.key(scope));
      return null;
    }
    return entry;
  }

  // Cookies filtered to the given host suffixes. Hosts may carry a port
  // ("127.0.0.1:9778") — cookies never do, so strip it before matching.
  cookiesFor(scope, hosts) {
    const entry = this.get(scope);
    if (!entry) return [];
    const wanted = hosts.map((h) => h.replace(/:\d+$/, "").replace(/^\./, ""));
    return entry.cookies.filter((c) => {
      const d = c.domain.replace(/^\./, "");
      return wanted.some((hh) => d === hh || d.endsWith("." + hh) || hh.endsWith("." + d));
    });
  }

  storageFor(scope, origin) {
    const entry = this.get(scope);
    if (!entry) return null;
    return entry.storages.find((s) => s.origin === origin) || null;
  }

  clear() {
    this.entries.clear();
  }

  stats() {
    return {
      scopes: [...this.entries.keys()],
      cookies: [...this.entries.values()].reduce((n, e) => n + e.cookies.length, 0),
    };
  }
}
