// Read a whole table out of a SQLite file without a native binding. Parses the
// b-tree by hand: enough for the flat cookies table, not a general engine.
import fs from "node:fs";

function debugLog(...args) {
  if (process.env.AGENT_BROWSER_DEBUG) process.stderr.write(`[sqlite-reader] ${args.join(" ")}\n`);
}

// The caller's DB may be actively written by Chrome, so a single pass can hit
// half-updated pages and silently under-report rows. Retry a few times and keep
// the cleanest pass; decodeFailures is attached to the result so callers can
// tell "no cookies" from "could not read them".
export async function readSqliteTable(file, tableName, { attempts = 3 } = {}) {
  let best = null;
  for (let a = 0; a < attempts; a++) {
    const { rows, failures } = readOnce(file);
    if (!best || failures < best.decodeFailures || (failures === best.decodeFailures && rows.length > best.length)) {
      best = rows;
      best.decodeFailures = failures;
    }
    if (failures === 0) break;
    debugLog(`pass ${a + 1} had ${failures} decode failures, retrying`);
    await new Promise((r) => setTimeout(r, 120));
  }
  return best;
}

function readOnce(file) {
  const buf = fs.readFileSync(file);
  const pageSize = buf.readUInt16BE(16);
  if (pageSize !== 4096 && pageSize !== 1024 && pageSize !== 2048 && pageSize !== 512 && pageSize !== 8192 && pageSize !== 16384 && pageSize !== 32768 && pageSize !== 65536) {
    throw new Error(`unsupported sqlite page size ${pageSize}`);
  }
  const usable = pageSize - buf.readUInt8(20); // reserved space per page

  // Walk every page looking for table-leaf pages, decode their cells.
  const rows = [];
  let failures = 0;
  const pageCount = Math.floor(buf.length / pageSize);
  for (let p = 1; p < pageCount; p++) {
    const pageStart = p * pageSize;
    const page = buf.subarray(pageStart, pageStart + pageSize);
    const type = page[0];
    if (type !== 0x0d) continue; // 13 = table b-tree leaf

    const cellCount = page.readUInt16BE(3);
    let cellPtrOff = 8;
    for (let i = 0; i < cellCount; i++) {
      const cellOff = page.readUInt16BE(cellPtrOff + i * 2);
      if (cellOff >= usable) continue;
      try {
        const row = decodeCell(page, cellOff);
        if (row) rows.push(row);
      } catch (e) {
        failures += 1;
        debugLog("cell decode failed on page", p, e.message);
      }
    }
  }
  return { rows, failures };
}

// A table-leaf cell: varint payload length, varint rowid, then the record.
function decodeCell(page, off) {
  let p = off;
  const [payloadLen, n1] = readVarint(page, p);
  p += n1;
  const [rowid, n2] = readVarint(page, p);
  p += n2;
  const payload = page.subarray(p, p + payloadLen);
  return decodeRecord(payload, rowid);
}

// A record: header length varint, then serial-type varints, then the values.
// Serial types: 0=NULL, 1..6=int, 7=float, 8=0, 9=1, 12+2k=blob, 13+2k=text.
function decodeRecord(buf, rowid) {
  let p = 0;
  const [headerLen, n] = readVarint(buf, p);
  const headerEnd = headerLen;
  const types = [];
  let q = n;
  while (q < headerEnd) {
    const [t, nt] = readVarint(buf, q);
    q += nt;
    types.push(t);
  }
  const values = [];
  let v = headerEnd;
  for (const t of types) {
    if (t === 0) values.push(null);
    else if (t >= 1 && t <= 6) {
      const bytes = [0, 1, 2, 3, 4, 6, 8][t];
      values.push(readInt(buf, v, bytes));
      v += bytes;
    } else if (t === 7) {
      values.push(buf.readDoubleBE(v));
      v += 8;
    } else if (t === 8) values.push(0);
    else if (t === 9) values.push(1);
    else if (t >= 12 && t % 2 === 0) {
      const len = (t - 12) / 2;
      values.push(buf.subarray(v, v + len));
      v += len;
    } else if (t >= 13 && t % 2 === 1) {
      const len = (t - 13) / 2;
      values.push(buf.subarray(v, v + len).toString("utf8"));
      v += len;
    } else {
      throw new Error(`unknown serial type ${t}`);
    }
  }
  // cookies table column order (Chrome's schema):
  // 0 creation_utc, 1 host_key, 2 top_frame_site_key, 3 name, 4 value,
  // 5 encrypted_value, 6 path, 7 expires_utc, 8 is_secure, 9 is_httponly,
  // 10 last_access_utc, 11 has_expires, 12 is_persistent, 13 priority,
  // 14 samesite, 15 source_scheme, 16 source_port, 17 is_same_party
  if (values.length < 15) return null;
  const [
    creation_utc, host_key, _tfsk, name, value, encrypted_value, path,
    expires_utc, is_secure, is_httponly, _la, _he, _ip, _pri, samesite,
  ] = values;
  if (typeof host_key !== "string" || typeof name !== "string") return null;
  return {
    rowid,
    creation_utc: toNum(creation_utc),
    host_key,
    name,
    value: typeof value === "string" ? value : "",
    encrypted_value: encrypted_value instanceof Uint8Array ? encrypted_value : null,
    path: typeof path === "string" ? path : "/",
    expires_utc: toNum(expires_utc),
    is_secure: toNum(is_secure) === 1,
    is_httponly: toNum(is_httponly) === 1,
    samesite: toNum(samesite),
  };
}

function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return 0;
}

function readInt(buf, off, bytes) {
  let v = 0n;
  for (let i = 0; i < bytes; i++) v = (v << 8n) | BigInt(buf[off + i]);
  // Two's complement for 6- and 8-byte ints.
  if (bytes === 8) return Number(BigInt.asIntN(64, v));
  if (bytes === 6) return Number(BigInt.asIntN(48, v));
  return Number(v);
}

function readVarint(buf, off) {
  let value = 0n;
  let i = 0;
  for (; i < 8; i++) {
    const b = buf[off + i];
    value = (value << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) return [Number(value), i + 1];
  }
  // 9th byte uses all 8 bits.
  const b = buf[off + 8];
  value = (value << 8n) | BigInt(b);
  return [Number(value), 9];
}
