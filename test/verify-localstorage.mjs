// localStorage reader: unit checks on synthetic leveldb bytes, plus a
// read-only smoke pass over the real profile. Values are never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snappyDecompress, readLocalStorage } from "../src/localstorage-reader.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
}

// --- snappy round-trip: a literal-only stream is valid snappy input.
function snappyLiteralOnly(data) {
  const out = [];
  const varint = (n) => {
    while (n >= 128) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n);
  };
  varint(data.length);
  for (let i = 0; i < data.length; ) {
    const chunk = data.subarray(i, i + 60); // tag len max is 60 → fits one byte
    out.push(((chunk.length - 1) << 2) | 0);
    out.push(...chunk);
    i += chunk.length;
  }
  return Buffer.from(out);
}
for (const size of [10, 5000, 200000]) {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  const enc = snappyLiteralOnly(data);
  let dec = null, err = null;
  try { dec = snappyDecompress(enc); } catch (e) { err = e.message; }
  check(`snappy round-trip ${size}B`,
    dec && dec.equals(data) && !err,
    err || `decoded ${dec ? dec.length : 0}`);
}
// small-block path: tag < 60, and the 60..63 extended-length path via a 61-byte literal
const exact61 = Buffer.alloc(61, 0x41);
check("snappy literal length 61 (extended tag)",
  snappyDecompress(snappyLiteralOnly(exact61)).equals(exact61));

// --- synthetic .log with a real WriteBatch
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-ls-"));
const ldb = path.join(dir, "Default", "Local Storage", "leveldb");
fs.mkdirSync(ldb, { recursive: true });

function varint(n) {
  const out = [];
  while (n >= 128) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
function entry(type, key, value) {
  const out = [type, ...varint(key.length), ...key];
  if (type === 1) out.push(...varint(value.length), ...value);
  return out;
}
const utf8 = (s) => [...Buffer.from(s, "utf8")];
const utf16 = (s) => [...Buffer.from(s, "utf16le")];
const L = (origin, k) => utf8(`_${origin}\x00\x01${k}`);
// Chrome 155 semantics (measured): 0x01 = latin1, 0x00 = utf16le.
const V = (s) => [0x01, ...utf8(s)];
const V16 = (s) => [0x00, ...utf16(s)];

const batch = [
  ...Buffer.alloc(8).map(() => 0), // sequence 0 (LE64)
];
const countBuf = Buffer.alloc(4);
countBuf.writeUInt32LE(4);
batch.push(...countBuf);
batch.push(...entry(1, L("https://unit.test", "k2"), V("plain-hello")));
batch.push(...entry(1, L("https://unit.test", "k3"), V16("中文值-keep")));
batch.push(...entry(1, L("https://other.test", "only"), V("x")));
batch.push(...entry(0, L("https://unit.test", "k1"), [])); // deleted afterwards

// log record header: crc(4)=0 len(2) type(1)=FULL
const payload = Buffer.from(batch);
const rec = Buffer.alloc(7 + payload.length);
rec.writeUInt16LE(payload.length, 4);
rec[6] = 1; // FULL
payload.copy(rec, 7);
fs.writeFileSync(path.join(ldb, "000003.log"), rec);

const ls = await readLocalStorage({ profileRoot: dir, origins: ["https://unit.test"] });
const unit = ls.byOrigin["https://unit.test"] || {};
check("log: tombstone removes the deleted key", unit.k1 === undefined, `k1=${JSON.stringify(unit.k1)}`);
check("log: latin1-flag value decodes", unit.k2 === "plain-hello",
  `k2=${JSON.stringify(unit.k2).slice(0, 40)}`);
check("log: utf16-flag value decodes", unit.k3 === "中文值-keep",
  `k3=${JSON.stringify(unit.k3).slice(0, 40)}`);
check("log: unrequested origin filtered out", Object.keys(ls.byOrigin).length === 1,
  JSON.stringify(Object.keys(ls.byOrigin)));
const asked = await readLocalStorage({ profileRoot: dir, origins: ["https://other.test"] });
check("log: other.test has its key when asked", asked.byOrigin["https://other.test"]?.only === "x",
  JSON.stringify(Object.keys(asked.byOrigin)));

// --- real profile, read-only smoke: counts only, no values.
// Opt-in: this reads a live Chrome profile, so it runs only when the caller
// points at one. Publishing it as an unconditional step would both leak the
// author's own path and fail on every other machine.
const REAL_PROFILE = process.env.CHROME_PROFILE_ROOT || "";
if (!REAL_PROFILE || !fs.existsSync(REAL_PROFILE)) {
  check("real-profile smoke skipped", true,
    "set CHROME_PROFILE_ROOT=<Chrome User Data 目录> 才会跑这三条");
} else {
  const real = await readLocalStorage({ profileRoot: REAL_PROFILE });
  check("real profile parses without file errors", real.incomplete === false,
    `files with errors: ${real.fileErrors.length}`);
  check("real profile yields a real amount of state", real.origins.length >= 50 && real.valueCount >= 500,
    `origins=${real.origins.length} values=${real.valueCount}`);
  const doubao = real.byOrigin["https://www.doubao.com"];
  check("real profile: doubao device state is readable", !!doubao && Object.keys(doubao).length >= 3,
    doubao ? `keys=${Object.keys(doubao).length}` : "absent (acceptable if the site was cleared)");
}

fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
