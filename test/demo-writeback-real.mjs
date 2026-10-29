// 真机回写演示（他已授权）：桥上写 quotes.toscrape.com 一枚 cookie 到他浏览器，
// 读回验证，最后清理。值不打印，只打印名字/长度/布尔。
import { createIdentityBridge } from "../src/bridge.js";

const SITE = "quotes.toscrape.com";
const NAME = "ab_writeback_demo";
const VALUE = "demo-" + Math.random().toString(36).slice(2, 10);

const bridge = await createIdentityBridge({ port: 8791 });
console.log("bridge listening on 8791, hosting=" + (bridge.hosting !== false));

// 等扩展报到（worker 30s 保活，实测 27~48s）
const T0 = Date.now();
const deadline = T0 + 75_000;
while (!(bridge.status().connected) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
}
const st = bridge.status();
console.log(`extension connected=${st.connected} id=${st.extensionId} waited=${Math.round((Date.now() - T0) / 1000)}s`);
if (!st.connected) {
  console.log("RESULT: bridge never connected — extension not loaded or Chrome closed");
  await bridge.stop();
  process.exit(1);
}

// worker 随时可能被 Chrome 回收，复活要等 30s 闹钟（实测 27~48s），
// 所以每条请求都给 75s；读仍超时就再试一发。
const REQ = { timeoutMs: 75_000 };

async function readWithRetry(domains) {
  try {
    return await bridge.cookies(domains, REQ);
  } catch (e) {
    console.log(`first read timed out (${String(e.message).slice(0, 80)}); retrying once`);
    return await bridge.cookies(domains, REQ);
  }
}

// 前置：确认他浏览器里该站当前没有这枚 cookie
const before = await readWithRetry([SITE]);
console.log(`before: ${before.length} cookies on ${SITE}, demo present=${before.some((c) => c.name === NAME)}`);

// 写入（走扩展 chrome.cookies.set，Chrome 自己落盘）
const payload = [{
  name: NAME,
  value: VALUE,
  domain: SITE,
  path: "/",
  secure: true,
  httpOnly: false,
  expirationDate: Math.floor(Date.now() / 1000) + 3600,
}];
const apply = await bridge.setCookies(payload, REQ);
console.log("apply result:", JSON.stringify(apply));

// 读回验证（只报名字与长度，不报值）
const after = await readWithRetry([SITE]);
const got = after.find((c) => c.name === NAME);
const match = got && got.value === VALUE;
console.log(`after: ${after.length} cookies, demo present=${!!got} valueMatch=${match} len=${got ? got.value.length : 0}`);

// 清理：只删自己写的那一枚
const rm = await bridge.removeCookies([{ name: NAME, domain: SITE, path: "/" }], REQ);
console.log("cleanup:", JSON.stringify(rm));
const final = await bridge.cookies([SITE]);
console.log(`final: demo present=${final.some((c) => c.name === NAME)}`);

const ok = apply?.applied?.includes(NAME) === true && match === true && rm?.removed?.includes(NAME) === true;
console.log(`RESULT: ${ok ? "WRITEBACK-CHAIN-VERIFIED" : "CHAIN-FAILED"}`);
await bridge.stop();
process.exit(ok ? 0 : 1);
