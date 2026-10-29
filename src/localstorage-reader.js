// Read Chrome's localStorage straight off disk, without a native binding and
// without touching the user's browser: Default/Local Storage/leveldb holds the
// entries as plain LevelDB records (values are NOT encrypted, unlike cookies).
//
// Coverage, stated honestly: we fold every record we can parse (.log write-ahead
// batches and .ldb tables) by highest sequence number, which approximates the
// effective state. A file that fails mid-parse marks the result `incomplete`
// rather than silently returning a half world. sessionStorage is memory-only in
// the running browser and cannot be read this way.

import fs from "node:fs";
import path from "node:path";

// ------------------------------------------------------------------ varints

function readVarint(buf, off, max = 10) {
  let result = 0n;
  let shift = 0n;
  const end = Math.min(buf.length, off + max);
  for (let i = off; i < end; i++) {
    const b = buf[i];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(result), i + 1];
    shift += 7n;
  }
  throw new Error("varint runs past end");
}

// ------------------------------------------------------------------- snappy

// Minimal decompressor: literals + the three copy forms. Enough for Chrome's
// leveldb blocks; anything else fails loudly instead of returning junk.
export function snappyDecompress(buf) {
  let [size, off] = readVarint(buf, 0);
  const out = Buffer.allocUnsafe(size);
  let o = 0;
  while (off < buf.length) {
    const tag = buf[off++];
    const type = tag & 3;
    if (type === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        // Tags 60..63 mean "the next (len-59) bytes hold the real length".
        const extra = len - 59;
        len = 0;
        for (let i = 0; i < extra; i++) len |= buf[off + i] << (8 * i);
        off += extra;
      }
      len += 1;
      buf.copy(out, o, off, off + len);
      off += len;
      o += len;
    } else {
      let len, dist;
      if (type === 1) {
        len = ((tag >> 2) & 0x7) + 4;
        dist = ((tag >> 5) & 0x7) << 8 | buf[off];
        off += 1;
      } else if (type === 2) {
        len = (tag >> 2) + 1;
        dist = buf.readUInt16LE(off);
        off += 2;
      } else {
        len = (tag >> 2) + 1;
        dist = buf.readUInt32LE(off);
        off += 4;
      }
      if (dist > o || dist === 0) throw new Error("snappy copy before start");
      for (let i = 0; i < len; i++) out[o + i] = out[o - dist + i];
      o += len;
    }
  }
  if (o !== size) throw new Error(`snappy size mismatch: wrote ${o} of ${size}`);
  return out;
}

// --------------------------------------------------------------- log (.log)

// LevelDB log: 32 KiB blocks of [crc32(4) len(2) type(1) payload]; a logical
// record may be split FIRST/MIDDLE/LAST across blocks.
function* logRecords(buf) {
  const BLOCK = 32768;
  let pending = null;
  for (let pos = 0; pos + 7 <= buf.length; ) {
    const blockRemain = BLOCK - (pos % BLOCK);
    if (blockRemain < 7) {
      pos += blockRemain; // trailer zero-fill
      continue;
    }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (type === 0 && len === 0) {
      pos += BLOCK - (pos % BLOCK); // zero region: skip to next block
      continue;
    }
    const payload = buf.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 1) {
      if (pending) pending = null;
      yield payload;
    } else if (type === 2) {
      pending = Buffer.from(payload);
    } else if (type === 3) {
      if (pending) pending = Buffer.concat([pending, payload]);
    } else if (type === 4) {
      if (pending) {
        yield Buffer.concat([pending, payload]);
        pending = null;
      }
    }
  }
}

// WriteBatch: seq(8 LE) + count(4 LE), then [type klen key vlen value]*
function* batchEntries(payload, baseSeq) {
  if (payload.length < 12) return;
  let off = 12;
  const count = payload.readUInt32LE(8);
  for (let n = 0; n < count && off < payload.length; n++) {
    const type = payload[off++];
    let klen;
    [klen, off] = readVarint(payload, off);
    const key = payload.subarray(off, off + klen);
    off += klen;
    if (type === 1) {
      let vlen;
      [vlen, off] = readVarint(payload, off);
      const value = payload.subarray(off, off + vlen);
      off += vlen;
      yield { type, key, value, seq: baseSeq + n };
    } else {
      yield { type, key, value: null, seq: baseSeq + n };
    }
  }
}

// --------------------------------------------------------------- table (.ldb)

function blockHandleAt(buf, off) {
  let o = off;
  let offset, size;
  [offset, o] = readVarint(buf, o);
  [size, o] = readVarint(buf, o);
  return { offset, size, next: o };
}

function readBlock(buf, handle) {
  const raw = buf.subarray(handle.offset, handle.offset + handle.size);
  const comp = buf[handle.offset + handle.size];
  if (comp === 0) return raw;
  if (comp === 1) return snappyDecompress(raw);
  throw new Error(`unknown block compression ${comp}`);
}

// Data block entries: shared unshared vlen key_delta value; the tail holds a
// restart array (num_restarts × 4 bytes) preceded by its count.
function* blockEntries(block) {
  if (block.length < 4) return;
  const numRestarts = block.readUInt32LE(block.length - 4);
  const limit = block.length - 4 - 4 * numRestarts;
  let off = 0;
  let last = Buffer.alloc(0);
  while (off < limit) {
    let shared, unshared, vlen;
    [shared, off] = readVarint(block, off);
    [unshared, off] = readVarint(block, off);
    [vlen, off] = readVarint(block, off);
    const key = Buffer.concat([last.subarray(0, shared), block.subarray(off, off + unshared)]);
    off += unshared;
    const value = block.subarray(off, off + vlen);
    off += vlen;
    last = key;
    yield { key, value };
  }
}

// Footer: last 48 bytes → metaindex + index handles + magic 0xdb4775248b80fb57.
function* tableRecords(buf) {
  if (buf.length < 52) throw new Error("table too small");
  const footer = buf.subarray(buf.length - 48);
  const magic = footer.readBigUInt64LE(40);
  if (magic !== 0xdb4775248b80fb57n) throw new Error("not a leveldb table (bad magic)");
  const meta = blockHandleAt(footer, 0); // metaindex, unused
  const index = blockHandleAt(footer, meta.next);
  const indexBlock = readBlock(buf, index);
  for (const entry of blockEntries(indexBlock)) {
    const handle = blockHandleAt(entry.value, 0);
    const dataBlock = readBlock(buf, handle);
    for (const de of blockEntries(dataBlock)) yield de;
  }
}

// Internal keys in tables carry an 8-byte trailer: (seq << 8) | type.
const INTERNAL_TRAILER = 8;

// Internal iterators are exported for diagnostics and tests.
export { logRecords, batchEntries, tableRecords, blockEntries, readBlock };

// --------------------------------------------------------------- assemble

// Flag byte before the value data. Measured on Chrome 155 (stored "DEV_7311"
// as 0x01 + plain ASCII): 0x01 = one-byte/Latin-1, 0x00 = UTF-16LE. Several
// older writeups have these two reversed — trust the bytes.
const LS_FLAG_UTF16 = 0x00;
const LS_FLAG_LATIN1 = 0x01;

function decodeLsValue(buf) {
  if (!buf || buf.length === 0) return "";
  const flag = buf[0];
  const rest = buf.subarray(1);
  if (flag === LS_FLAG_UTF16) return rest.toString("utf16le");
  if (flag === LS_FLAG_LATIN1) return rest.toString("latin1");
  // Unknown flag: prefer a lossless-looking decode over throwing.
  return rest.toString("utf8");
}

// `_https://origin\x00<entry>` — the entry starts with a 0x01 map-key tag in
// Chromium's wrapper scheme, then the site's own key. Split at the first NUL
// after the leading underscore and strip the tag.
function splitLsKey(keyBuf) {
  if (keyBuf.length < 2 || keyBuf[0] !== 0x5f) return null;
  const nul = keyBuf.indexOf(0x00, 1);
  if (nul === -1) return null;
  let rest = keyBuf.subarray(nul + 1);
  if (rest[0] === 0x01) rest = rest.subarray(1);
  return {
    origin: keyBuf.subarray(1, nul).toString("utf8"),
    key: rest.toString("utf8"),
  };
}

function normOrigin(o) {
  return String(o || "").replace(/\/$/, "").replace(/:80$/, "").replace(/:443$/, "");
}

export async function readLocalStorage({ profileRoot, origins = null, raw = false } = {}) {
  const dir = path.join(profileRoot, "Default", "Local Storage", "leveldb");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".log") || f.endsWith(".ldb"));
  } catch {
    return { byOrigin: {}, origins: [], incomplete: false, dir, scanned: 0, note: "no Local Storage leveldb directory" };
  }
  files.sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));

  // user key -> {seq, type, value}; highest sequence wins, delete removes.
  const state = new Map();
  let incomplete = false;
  let scanned = 0;
  const fileErrors = [];

  const apply = (userKey, seq, type, value) => {
    const prev = state.get(userKey);
    if (!prev || seq > prev.seq) state.set(userKey, { seq, type, value });
  };

  for (const f of files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, f));
    } catch {
      incomplete = true;
      continue;
    }
    try {
      if (f.endsWith(".log")) {
        let seq = 0; // per-batch bases come from the batch header
        for (const payload of logRecords(buf)) {
          const baseSeq = Number(payload.readBigUInt64LE(0));
          for (const e of batchEntries(payload, baseSeq)) {
            apply(e.key.toString("latin1"), e.seq, e.type, e.value);
            scanned += 1;
          }
          seq += 1;
        }
      } else {
        for (const e of tableRecords(buf)) {
          const trailer = e.key.length >= INTERNAL_TRAILER ? e.key.subarray(e.key.length - 8) : null;
          if (!trailer) continue;
          // Internal key trailer is LE64((seq << 8) | type): the type sits in
          // the LOW byte, seq in the upper seven.
          const raw = trailer.readBigUInt64LE(0);
          const seq = Number(raw >> 8n);
          const type = Number(raw & 0xffn);
          apply(e.key.subarray(0, e.key.length - 8).toString("latin1"), seq, type, e.value);
          scanned += 1;
        }
      }
    } catch (e) {
      incomplete = true;
      fileErrors.push({ file: f, error: String(e.message || e).slice(0, 160) });
    }
  }

  const byOrigin = {};
  const seenOrigins = new Set();
  let splitFailures = 0;
  let valueCount = 0;
  const typeHist = {};
  for (const [userKey, rec] of state) {
    typeHist[String(rec.type)] = (typeHist[String(rec.type)] || 0) + 1;
    if (rec.type !== 1) continue; // tombstone
    valueCount += 1;
    const split = splitLsKey(Buffer.from(userKey, "latin1"));
    if (!split) {
      splitFailures += 1;
      continue;
    }
    seenOrigins.add(split.origin);
    if (origins && !origins.some((o) => normOrigin(o) === normOrigin(split.origin))) continue;
    (byOrigin[split.origin] ||= {})[split.key] = raw
      ? Buffer.from(rec.value || []).toString("hex")
      : decodeLsValue(rec.value);
  }

  return {
    byOrigin,
    origins: [...seenOrigins],
    incomplete,
    dir,
    scanned,
    stateSize: state.size,
    valueCount,
    splitFailures,
    typeHist,
    fileErrors,
  };
}
