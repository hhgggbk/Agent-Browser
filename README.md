# Agent Browser Runtime

给 agent 用的静默浏览器 + 用户登录态复用。**不复制 cookie 回用户浏览器，只增量回写任务期间新获得的站点凭据**——这是计划书相对「双向同步」方案的核心改动：没有全量复制，就没有 session 冲突。

设计文档：[`../PLAN.md`](../PLAN.md) · 功能与用法总览：[`功能介绍.md`](功能介绍.md)（这份 README 记的是实测过程、失败记录和踩坑细节）

## 一次任务的数据流

```
用户 Chrome（日常使用，不重启、不加参数）
   │ ① 身份桥：扩展的 chrome.cookies.getAll → Chrome 自己解出明文（无端口也行）
   ▼     （若另有 --remote-debugging-port 的非默认 profile，则走 CDP 实时抓，含 localStorage）
Identity Vault（纯内存，TTL，任务结束清空）
   │ ② 按白名单域过滤
   ▼
Agent 浏览器（headless Chromium，临时 profile，任务结束即删）
   │ ③ agent 操作页面；每次导航过路径级禁区检查（支付/账号安全/实名/注销 拦死）；
   │    Set-Cookie 分流：新站点→回写队列 / 轮换→只更 Vault
   ▼
④ 仅「用户 profile 中不存在的站点」回写：扩展的 chrome.cookies.set，
   或 CDP Network.setCookie（有端口时）——都由浏览器自己落盘，不碰它的 SQLite
```

## 使用

```bash
cd agent-browser
node C:/nvm4w/nodejs/node_modules/npm/bin/npm-cli.js install   # 只装 playwright-core

# 列出用户浏览器里已登录的站点（≥2 个 cookie 视为有会话）
node src/broker.js --list

# 跑一个任务
node -e "
import('./src/broker.js').then(async ({runTask}) => {
  const r = await runTask(async (agent) => {
    const p = await agent.page('https://github.com');
    console.log(await p.title());
    await p.close();
  }, { config: { whitelist: { hosts: ['github.com'] } } });
  console.log(r);
});
"
```

`runTask` 的返回值是 `{ ok, writeback, guardViolations }`：`guardViolations` 每项是 `{url, rule, category, at}`（站内跳转被拦下的账，页已经被关掉）；`agent.page()` 直接打开禁区则在发请求前抛 `GuardViolation`，错误里带命中的规则和类别。

## 一次性配置（用户侧）

`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `agent-browser/cookie-extension`。**一次点完，之后不用重启浏览器、不用加命令行参数。**

> 旧建议「给日常 Chrome 快捷方式加 `--remote-debugging-port=9222`」在 Chrome 136+ 上已失效：默认 profile 目录会被直接忽略该参数（`DevTools remote debugging requires a non-default data directory`）。要真用 CDP，只能给一个**非默认** `--user-data-dir` 开端口，那就不是你的日常登录态了。

桥没连上、端口也没有时，任务**明确失败**并打印上面这段装载路径，不会静默拿一套匿名会话冒充你。

## 为什么不能直接读 Cookies 数据库（2026-10-14 实测）

一度以为 DB 被 Chrome 锁住读不了。**这个判断是错的**，实测推翻：

| 检查 | 结果 |
|---|---|
| `fs.openSync(DB, "r")` 读 16 字节 | 成功，头部是 `SQLite format 3` |
| `fs.openSync(DB, "r+")` | 成功 |
| `fs.readFileSync` 整个 1.6 MB DB | 成功 |
| 手写 SQLite b-tree 解析器解表 | **3550 行、1046 个 host_key 全部解出**，GitHub 的 22 个 cookie 一个不落 |

之前看到的 `EBUSY` 来自 Git Bash 的 `cp`/`grep`，不是 Chrome 的文件锁。

真正堵路的是加密，不是锁：

- 密文前缀是 **`v20`**，`Local State` 里有独立的 `app_bound_encrypted_key` 字段；
- v20 = Chrome 127+ 的 app-bound encryption，解密要经过 Chrome 进程的 elevated COM 服务（`ICHROME_CRYPT_UNWRAP`），外部进程调不动；
- 实测 `encrypted_value present: 3550`，`plaintext value column: 0`——**零明文**。

第二条死路也验了：起第二个 Chrome 进程开同一个 profile + CDP 端口。Chrome 自己拒绝：

```
DevTools remote debugging requires a non-default data directory.
Specify this using --user-data-dir.
```

rea 的 browser provider 也试过，`CdpCaptureStorage.js` 是脱敏设计——`values_redacted: true`，只给 key 名和 sha256 指纹，不返回任何值。

**所以：外部进程拿不到明文。能拿到明文的只有 Chrome 自己**——要么它把值交给 CDP（需要调试端口），要么它把值交给扩展的 `chrome.cookies`（不需要端口，见下一节）。

### 「绕开默认目录的端口限制」这条路我试过，没测出来（2026-10-15）

Chrome 136+ 在默认 profile 目录上直接忽略 `--remote-debugging-port`。想绕，思路是让「传进去的目录」不等于「Chrome 认为的默认目录」：改 `LOCALAPPDATA`、8.3 短名、junction、结尾点、正斜杠、大小写。

实测**不能得出任何结论**，原因在实验设计本身：Chrome 用 Windows known-folder API 解析默认目录，**不读子进程的 `LOCALAPPDATA`**。所以放在伪造 `LOCALAPPDATA` 下的临时目录永远不可能「等于默认目录」，六组拼写（含逐字相同的那组对照）全部 `port=OPEN` —— 这套装置压根打印不出 REFUSED，没有阳性对照。`test/probe-port-restriction.mjs` 头部已按此标注作废。

要真正测它只能拿你真实 profile 试，而那要先关掉你正在用的 Chrome —— 没做，等你点头。

同一个探针当时的第二处误读也已更正：`marker=GONE(jar=0)` 是我播的 cookie 没带 `expires`（session cookie，Chrome 本来就不跨重启恢复），不是 Chrome 删了它。带 `expires` 重测三档（同环境重开、`Stop-Process -Force` 之后、换 `LOCALAPPDATA` 重开）**全部存活**，见 `test/probe-cookie-durability.mjs`。

## 试过的绕过：拷 profile 让新 Chrome 解密 —— 失败（2026-10-14）

思路是合法的：不碰密文，让一个我们启动的 Chrome 在 profile 副本上自己解密，再通过 CDP 读明文。Chrome 拒绝给默认目录开调试端口，那就给副本开。

**第一次测量看起来成功了**，拿到 `tz=Asia/Shanghai`、`_gh_sess`（348 字符）、`_octo`，而且每次跑值都不同。当时据此判断「活会话、绕过去了」——**这个结论是错的**，本节把它撤掉。

错误在于没有先立对照组。补上做完全量对照后，真相是：

| 实验 | 结果 |
|---|---|
| 副本启动**前**读它的 Cookies DB | **3550 行**（含 22 个 github cookie） |
| 副本启动 + 关闭**后**再读同一个文件 | **0 行**，文件大小仍是 1671168 字节 |
| `context.cookies()` 在导航前 | **0 个** |
| 写入一个 marker cookie → 关闭 → 重开同目录再读 | **1 个**（证明读 API 不瞎，0 是真的 0） |
| 导航到 bilibili 后查 `SESSDATA`/`DedeUserID` | 全部 ABSENT，页面未登录 |

**Chrome 打开一个 app-bound 密钥对不上的 profile 时，直接把整个 cookie 库清空**（3550 → 0），而不是保留密文。然后访问任何站点时铸造一套全新的匿名会话。

所以那 6 个「明文 cookie」全是新铸的：`tz` 是 GitHub 的 JS 读浏览器时区写的，`_gh_sess`/`_octo`/`cpu_bucket`/`preferred_color_mode` 是匿名访客默认值。**看起来是真的，实际不是这个人的。**

这种失败模式比报错更糟——它会静默伪造身份，让 agent 以为自己带着用户的登录态去干活。因此代码里不留这条路径，`capture.js` 头部注释写明了测量数据。

**你原始的 profile 没受影响**：实验只动临时副本，实验后复查原始 DB 仍是 3550 行 / 22 个 github cookie（含 `user_session`）。

顺带修掉一个真 bug：磁盘清点读的是 Chrome **正在写**的 DB，单次遍历会撞上更新中的页导致解码失败，而失败被 `catch` 吞掉，于是同一个测试第一次报 0 行、第二次报 18 行。现在 `readSqliteTable` 最多重试 3 趟取最干净的一次，并在结果上挂 `decodeFailures`，调用方用 `diskIncomplete` 区分「真的没有」和「没读全」。修复后稳定 18 行（磁盘 22 个含 `github.io` / `githubstatus.com` 的按域匹配正确排除 4 个）。


## 通道：身份桥（扩展）——现在的主路径

端口限制堵的是**外部进程**访问你日常浏览器；`chrome.cookies` 是 Chrome **授权给自己扩展**的接口，值由浏览器自己解密。所以桥不绕开任何安全边界，它用的是 Chrome 明确给你的那条路。

```
你的 Chrome（照常使用，不重启、不加参数）
   │ chrome.cookies.getAll(domains) → 明文
   ▼  http://127.0.0.1:8791 长轮询，每次只答白名单里的域
src/bridge.js（本机 HTTP，绑定 127.0.0.1，每次启动一把随机 key）
   ▼
Identity Vault → agent 浏览器
```

装载（一次性，你自己在 `chrome://extensions` 点）：

```
chrome://extensions → 右上角「开发者模式」→ 「加载已解压的扩展程序」
→ 选择 agent-browser/cookie-extension
```

装载后自检：`chrome://extensions` → 本扩展「详情」→ 记下扩展 ID → 地址栏开
`chrome-extension://<扩展ID>/probe.html`。它会打出 `chrome.cookies` 是否可用、能不能连上 `127.0.0.1:8791`、以及后台 worker 是否醒着——这三件事分得开「没连上桥」和「扩展没跑」。

之后 `node src/broker.js` 与 MCP 的 `get_cookies` 都会自动走这条；桥没连上时 `cookie_source_info` 会如实报 `bridge.available=false` 并给上面这段路径。

- **只监听 127.0.0.1**，只回你要的域，值不落盘、不写日志；扩展代码里没有任何远端主机。
- 端口已被别的进程占用时自动转为**客户端**（`BridgeClient`），所以 MCP 常驻进程和一次任务不会抢同一个端口——这条也测了。
- 回写同样走扩展的 `chrome.cookies.set`，规则不变（见下节）。**这是新增的第二条回写路**：以前只有 CDP 一条，而你日常那个 Chrome 根本开不了端口，所以那条对你的主浏览器其实是空的。
- 信任边界说清楚：绑定 127.0.0.1 + 每次启动换 key，能挡住远端主机和顺手扫端口本机进程；**挡不住已经以你身份运行的恶意程序**——那条边界和 cookie 本身在同一个信任域里，本项目不假装解决了它。

### 参照 Extension.js：它那几个参数在本机成不成立（2026-10-18 实测）

翻了 `extension.js-main.zip`（extension.js.org 的 monorepo，跨浏览器扩展开发框架 + CLI）。它启动浏览器时固定带这几个参数，看着像是能替我们省掉「你手动点一次加载」：

| 它的参数 | 它自己写的理由 | 本机 Chrome 155 实测 |
|---|---|---|
| `--disable-features=DisableLoadExtensionCommandLineSwitch` | Chrome 150 起无视 `--load-extension`，除非关掉这个开关 | **无效** |
| `--enable-unsafe-extension-debugging` | Chrome 126+ 允许 CDP 管理扩展 | 不需要——不带它 `Extensions.loadUnpacked` 本来就能用 |
| `--disable-features=ExtensionDisableUnsupportedDeveloper` | Chromium 152+ 会在第一次 `runtime.reload()` 后**永久停用**未打包的开发扩展 | 用不上（见下条红线） |
| `--disable-features=SafetyHubExtensionsOffStoreTrigger` | Chrome 126+ reload 之后把未打包扩展标成不安全 | 用不上（同上） |
| `--silent-debugger-extension-api` | 压掉「某某正在调试此浏览器」的横幅 | 未测（原生横幅不在 DOM 里，得肉眼判） |

七臂探针 `node test/probe-load-extension-flag.mjs`，判据用「扩展自己向桥打 `/hello`」这种功能信号，不是看 target 列表里冒出一条：

```
1-none                 helloMs=null   ← 阴性对照
2-load-extension       helloMs=null
3-flag                 helloMs=null
5-both-flags           helloMs=null   ← 两个参数一起加也没用
6-headed-plain         helloMs=null   ← 有头形态（它默认就是有头）
7-headed-flag          helloMs=null
4-cdp loadUnpacked     helloMs=262~521ms  ← 阳性对照：装置能看见醒着的 worker
```

结论两条。① **10-15 那条「`--load-extension` 已废」没有被推翻**：无头/有头 × 有无参数四组全静默，只有 CDP `Extensions.loadUnpacked` 起得来。② Extension.js 自己在现代 Chrome 上走的也是 CDP `loadUnpacked`（源码里 `loadUnpackedIfNeeded`、`cdp-extension-controller`），`--load-extension` 只是留给老版本的双保险——**独立项目收敛到同一个机制，这条路选对了**。

顺带被这份参照**否掉的一个想法**：别给 `cookie-extension` 加自动 reload（监听文件变化自己 `chrome.runtime.reload()`）来提高开发体验。Chromium 152+ 会在第一次 reload 之后永久停用这个未打包扩展，而唯一的解药 `--disable-features=ExtensionDisableUnsupportedDeveloper` 只能加在**我们自己启动**的浏览器上——**你那个已经在跑的 Chrome 拿不到任何参数**。所以改完扩展仍然由你在 `chrome://extensions` 点一次刷新，这是有意的。

`programs/extension/browsers/browsers-lib/manifest-refusal.ts` 里那份「哪些 manifest 形状会被 Chrome 拒绝」的清单（`name` 必须非空字符串、`version` 必须 1–4 段点分整数、MV3 的 `web_accessible_resources` 必须是对象数组……）值得抄成装载前的 lint；我们的 `manifest.json` 已经在真机过了一遍，暂时不补。

## agent 浏览器自己装载扩展（2026-10-18）

`agent.extensions` 填未打包扩展目录即可（`config/default.json`、`new AgentBrowser({extensions:[…]})`、`runTask(…, {extensions:[…]})` 三处同一语义），装载只用 CDP `Extensions.loadUnpacked`——上一节实测过 `--load-extension` 在这台 Chrome 上是死的，而且它出现在命令行里还会把 CDP 那条也一起毒掉。

四条实测出来的事实，都钉在 `test/verify-extension.mjs` 里：

1. **Playwright 默认给 Chrome 塞 `--disable-extensions`**（拿活进程的命令行查出来的，57 个参数里点名列出）。这时 `loadUnpacked` 照样返回 id、`Target.getTargets` 里也没有它的工作进程，内容脚本一个都不注入——**装了，但完全不跑**，访问它的页面只会得到 `ERR_BLOCKED_BY_CLIENT`。所以 `extensions` 非空时才把这一个默认参数摘掉（`ignoreDefaultArgs`），不装扩展的任务命令行一个字节都没变。
2. **MV3 worker 是事件驱动的**：刚装完去 `Target.getTargets` 里找它，找不到。拿扩展自己的内容脚本发一条 `chrome.runtime.sendMessage` 把它叫醒之后，Playwright 的 `context.serviceWorkers()` 就列出来了。**「装好了却没跑」和「跑着但闲着」在 target 列表里长得一模一样**，判据只能是喂一个真事件看它答不答应。
3. **伸进扩展的三条路**：① 内容脚本世界——`Runtime.evaluate` 带 `contextId`（先用 `Runtime.executionContextCreated` 找到 `origin === chrome-extension://<id>` 那个世界）；② service worker——`worker.evaluate()`；③ 扩展页面当普通 tab 打开（`chrome-extension://<id>/popup.html` 直接 goto 就行，扩展活着就渲染）。
4. **裸 CDP attach 到 worker 走不通**：flatten 模式的 `sessionId` 是**消息信封**上的字段，不是 `params` 里的；Playwright 的 `cdpSession.send(method, params)` 没法设它，硬塞就落到 browser target 上，报 `'Runtime.evaluate' wasn't found`。

实测对象是手上现成的 `VideoDownloader`（未打包扩展目录，MV3 / webRequest+downloads+offscreen / 内容脚本 `*://*/*` all_frames），**15 项全过**：两个扩展同时装、id 形状、内容脚本注入成独立世界、内容脚本↔后台消息往返、worker 被叫醒后可 `evaluate`、扩展自己的文件从 worker 能读、popup 作为页面渲染出 `#btn-extract`、`chrome.cookies.getAll` 在 agent 浏览器里也通（cookie-extension 装进去之后 2 ms 就向桥报到）。

**这不改变你那边的任何东西**：扩展装在 agent 的一次性 profile 里，任务结束连 profile 一起删。你自己的 Chrome 里那个 `cookie-extension` 仍然靠你手动点一次加载——这条能力的方向是「agent 侧带扩展」，不是「往你浏览器里塞扩展」。

## 反过来用：在你自己的浏览器里开一页（不再开第二个实例）

双开风控那节的第三条路。既然扩展已经在你浏览器里、Chrome 又把 `chrome.cookies`/`chrome.tabs`/`chrome.scripting` 授权给它，那 agent 就不必再起一个浏览器——**由扩展在你那个 Chrome 里开一个后台标签页，直接带着你的凭据干活**，平台只看到一套环境。

代码：`src/user-tabs.js`（`UserTabs`）+ 扩展里的 `OPS` 菜单 + 桥上新增的 `tabOpen/tabInfo/tabClose/opRun` 四条命令。

```js
const bridge = await createIdentityBridge({ port: 8791 });
const tabs = new UserTabs({ bridge });
await tabs.connect();                      // 等扩展报到
const { tabId } = await tabs.open("https://www.doubao.com/");   // 后台标签，不抢焦点
await tabs.title(tabId);
await tabs.fill(tabId, "textarea", "帮我总结这个");
await tabs.close(tabId);                   // 或 closeAll()
```

三条安全性质是设计里钉死的，不是靠调用方自觉：

1. **只开不动**：`chrome.tabs.create({active:false})`（或 `chrome.windows.create({focused:false})`），不会跳走你正在看的那一页。
2. **只碰扩展自己开的标签页**：扩展记着它创建过的 tabId（内存 + `chrome.storage.session`），`tabInfo/opRun/tabClose` 一进来先验这条。你手动开的那些页面**结构上就够不着**——实测拿别人的 id 去问会被拒（`tab 999999 was not opened by this extension`）。
3. **注入的是固定菜单，不是任意代码**：MV3 的 service worker 没有 `eval`，所以 agent 只能从 `state/title/text/html/attr/exists/count/meta/links/inputs/click/clickIndex/fill/press` 里选，参数得是 JSON 可序列化的。「读我登录着的页面」不会被顺手放大成「在我登录着的页面里跑任何东西」。`fill` 走原生 setter + `input`/`change` 事件，否则 React/Vue 的状态不会跟着变。

禁区照样生效，而且这里**只能事后关**：`open()` 在请求前查一次、页面 `complete` 后按最终 URL 再查一次；此后**每次操作前**都重新读 tab 的真实 URL，发现它自己跳进了支付/改密码/实名/注销路径就当场 `tabClose` 并记进 `tabs.guardViolations`。

实测 `node test/verify-user-tabs.mjs`（一次性 profile + 真扩展，14 项）：后台标签 `active=false`、先 ANON→登录→**同浏览器新标签直接 AUTHED**、`meta[user-login]=hhgggbk`、`links/fill/click` 往返、禁区 URL 请求数 0、站内点按钮跳进 `/pay/confirm` 后下一次操作即被拦下并关页记账、陌生 tabId 被拒、`closeAll` 归零。**顺带量到一个坑**：装在浏览器里的扩展 worker 会被 Chrome 回收，靠 30 秒的保活闹钟才醒，所以 `connect()` 的等待窗口必须 ≥45 秒——按 20 秒写的话，一个完全健康的浏览器会被判成「没连上」。

**结果（2026-10-20）：已解决，真机 7/7。** 「移除 → 加载未打包 → 选 `agent-browser\cookie-extension`」之后，id 仍是 `ddnheipcnmaagaaelcinjhpojabjgakb`，`node test/verify-user-tabs.mjs --real doubao.com --type` 全过：后台标签 `active=false`、读回标题、往它**自己的编辑器里**写入文字并清除、关页，全程无禁区触发。

这一轮真机把两个合成测试抓不到的缺陷逼出来了：

- **`fill` 原来只认 `<textarea>`/`<input>`**。豆包的输入区是 `<textarea>` + `tiptap ProseMirror` 双结构，真实状态在编辑器模型里，所以「清空」用 value 赋值清不掉（套件实测 `after="agent-browser 验收占位"`）。现在 contenteditable 走「全选 → `execCommand` 删除/插入」，并在一次性 profile 里用「只有 input 事件才更新的镜像」验证了编辑器的模型确实收到（5/5）。
- **SPA 的输入框不在 `domcontentloaded` 时出现**。第一次探测只等 400 ms，`composerCount=0`；改成轮询到出现再写。

**自动化那个文件夹选择框的经验**（Windows 上没有别的入口）：UIA 读不到它的输入框与按钮；地址栏（Ctrl+L）能进，但**必须先按 Esc 退出上一次补全的下拉**，否则新路径会被追加到旧文本后面，回车后 Windows 报「找不到 …\agentD:\…\agent」这种拼起来的路径；Esc 之后补全会给出目标目录，再点「选择文件夹」即可。

## 管理你浏览器里的扩展（2026-10-20）

「能管理插件的一切」这轮的实现。扩展已经在你浏览器里，`chrome.management` 就是 Chrome 授权给它看/管其它扩展的接口——manifest 加了 `management` 权限，桥上新增六条命令（`extList/extDetail/extEnable/extReload/extUninstall/extLoad`），Node 侧封装 `src/extensions.js`（`ExtensionManager.list/find/detail/setEnabled/reload/uninstall/loadUnpacked`；`find` 按 id 或名字唯一匹配，歧义时把候选全列出来），MCP 侧 `list_extensions` + `extension_manage`（action: detail/enable/disable/reload/uninstall/load）。

Chrome 155 实测的能力边界，代码不装能做到：

| 操作 | 实测结果 |
|---|---|
| list / detail / enable / disable | **可用**。worker 里 `getAll/get/setEnabled` 都正常 |
| reload | **降级可用**：`chrome.management.reload` 在 Chrome 155 上不存在，实际走 disable→enable——worker 会醒，但**不重读磁盘上的代码**（结果里如实带 `how:"disable-enable"`、`rereadFromDisk:false`）。要换代码仍需你在 chrome://extensions 移除重装，原因见前面 reload 陷阱那节 |
| uninstall | **被 Chrome 拒**：`management.uninstall` 需要用户手势，worker 里调直接报 `This function must be called during a user gesture`。返回 `{removed:false, outcome:"refused", requiresUserConfirm:true}`，不假装成功。所以「移除」的实际路径仍然是你自己点一次 |
| load | **结构上没有**：`chrome.developerPrivate.loadUnpacked` 不对普通扩展开放——明确报这条路走不通，不猜 |

三条自我保护写在 handler 里，不靠调用方自觉：桥自己不能被停用/卸载/重载（回复丢了就是 30 秒超时）；`mayDisable:false` 的托管扩展拒动；目标已是期望态时返回 `unchanged:true` 不发命令。

`node test/verify-extensions.mjs`（一次性 profile + 两个未打包扩展，13 项全过）：list、id/名字查找、detail 字段、disable/enable 往返、unchanged 短路、reload 的 `how/rereadFromDisk` 如实上报、拒自卸载、拒自停用、uninstall 诚实失败、loadUnpacked 诚实失败、未知 id 报错。

## 免插件的那条路：只开一页，不驱动它（`src/user-browser.js` + `src/win-tabs.js`）

上面那条依赖扩展。还有一条**什么都不装**的路：`chrome.exe <url>` 不带任何参数，走 Chrome 自己的单实例 IPC，页面直接落进你正在用的那个窗口当新标签页——凭据本来就在原地，而且因为不带 `--user-data-dir`、不带 `--remote-debugging-*`，Chrome 136+ 那个默认目录闸门**根本不会被查询**。

反面也一并量清了：默认 profile 上两种 DevTools 传输都被拒（`--remote-debugging-port` 和 Playwright 的 `--remote-debugging-pipe` 都试了，报的就是前面那句 `DevTools remote debugging requires a non-default data directory.`）。所以免插件这条路**结构上不可能**读或驱动那个标签页——它能开页，仅此而已。

它一开始并不满足你提的要求。「新开页面但**不跳转新页面**」这条，Chrome 自己会破坏：命令行开的那页会被**激活**（实测：标签数 8 → 9，`selected` 7 → 8）。能把选中位还原回去的通道，在默认 profile 上只剩 Windows UIA 一个：

| 要的东西 | 实测到的选择器 | 能做什么 |
|---|---|---|
| Chrome 的标签栏 | `ControlType.Tab` 且 `ClassName=TabContainerImpl` | 唯一的真标签栏 |
| 单个标签页 | 上面容器的子 `TabItem`，`ClassName=Tab` | 读**标题**、`SelectionItemPattern.Select()` 选中 |
| 标签页的关闭钮 | 该 `TabItem` 下 `ClassName=TabCloseButton`（本地化 Name「关闭」） | `InvokePattern.Invoke()` |
| 前台窗口 | `GetForegroundWindow` + `SetForegroundWindow` | 把焦点还给别的程序 |

两个实测出来的坑：

1. **别对整个窗口 `FindAll(Descendants, TabItem)`**。你正在看的那一页自己就有 ARIA 标签页，会一起被算进来——实测一次拿到 11 个 `TabItem`，其中 2 个 `ClassName` 是 `wSkVaW_tab`/`wSkVaW_tabActive`，是页面内容不是浏览器 chrome。所以现在一律先定位 `TabContainerImpl`，再取它的直接子项。
2. **`SetForegroundWindow` 单发会被 Windows 的前台锁挡掉**（实测第一版 `focusRestored:false`）。`src/win-tabs.js` 的 `focus` 做成三级阶梯，实测生效的是第二级：`AttachThreadInput` 挂上当前前台线程 + `BringWindowToTop`（那次把他正在用的窗口 `pid=10244` 原样还了回去，rung=`attach`）。并且**只有 Chrome 此刻确实占着前台才去抢**——他自己已经切走了就写在 `focusSkipped` 里不动手。

```js
import { openInUserBrowser } from "./src/user-browser.js";

const r = await openInUserBrowser("https://www.doubao.com/");        // 默认 background:true
// r = {url, launched, restored, selectedAfter, tab:{hwnd,index,indexIsNew},
//      focusRestored, focusRung, startedBrowser, stderr}
await openInUserBrowser(url, { window: true });        // 开成新窗口而不是新标签
await openInUserBrowser(url, { background: false });   // 就让它跳过去
```

禁区在这条路上仍然是**先查再动手**：`openInUserBrowser("https://github.com/settings/tokens")` 抛 `GuardViolation`，`chrome.exe` 一次都没被调用（实测两条：支付类 `category=payment`、token 类同拦）；`guard.enabled=false` 时照样放行。

实测 `node test/verify-user-browser.mjs --real`（打你正在用的浏览器，13 项）：标签数 +1 而 `selected` 不动（4 → 4、7 → 7），测试**关掉自己开的那一页**并把浏览器还原成进门时的样子；`--keep` 可以留着那页不关。单次开页端到端 **2.1~3.2 秒**（每次 UIA 读约 1.7 秒，轮询刻意做成粗的）。

三条边界，写在明面上：

- **开 ≠ 驱动**。UIA 看得见标签页标题，看不见页面内容；要读 DOM、填框、点按钮，还得走上面扩展那条路。
- **落地的最终 URL 读不到**。标题不是 URL，所以这条路上禁区只有「发出去之前」那一次检查；站点自己 302 进支付页，这里既看不见也拦不住。扩展那条是每次操作前重读真实 URL。
- **标题就是浏览历史**。UIA 快照里带标签页标题，只走 `%TEMP%` 一个临时 JSON、读完立刻 `rmSync`，不落库、不打日志；`openInUserBrowser` 的返回值里也**不**含标题，只有下标和计数。

## 回写规则

| 情形 | 动作 |
|---|---|
| 站点用户从未登录过 | 回写 |
| cookie 值变了，且 agent 侧 `expires` 更新 | 回写（续期） |
| cookie 值变了，但用户侧更新或同样新 | 跳过（会把用户顶掉） |
| 值没变 | 跳过 |

默认回写前弹确认，列出「哪个站、新增几项、续期几项」；脚本化场景 `writeback.confirm: false`。

### 真机回写已验（2026-10-20，你点头的那发）

`node test/demo-writeback-real.mjs`：桥上向 `quotes.toscrape.com` 写一枚演示 cookie，走**扩展的 `chrome.cookies.set`**——Chrome 自己落盘，外部进程没碰任何文件。实测输出：

```
before: 0 cookies    → applied:["ab_writeback_demo"] → 读回 valueMatch=true
cleanup: removed 1   → final: demo present=false     → WRITEBACK-CHAIN-VERIFIED
```

值不打印、不落盘；测试自清理（写几枚删几枚）。README 此前一直标着的「真机回写未做」从这条起作废。

这一发先被一个新问题挡了一道，根因值得记：**扩展 hello 正常、长轮询活着（lastSeen 每 ~20s 刷新），但 ping/cookies/extList 全部 30~75s 超时**。诊断实锤是他浏览器里的 worker 跑的还是 `_rid` 信封改造**之前**装载的旧代码——旧代码读 `request.id` 回信 `{id:...}`，新桥只发 `_rid`，应答全部找不到收件人。MV3 worker 被 20s 长轮询养着永不回收，所以磁盘上已是新代码它也不会重读。修复不是逼你重装扩展，而是**桥把 `id` 与 `_rid` 同时发**（`bridge.js` 的 `request()`）：旧 worker 按 `id` 回、新 worker 按 `_rid` 回，结果路由 `body._rid ?? body.id` 两边都认。此前的阻塞「他的 Chrome 打不开 quotes.toscrape.com」也已消失——系统代理（ProxyEnable=0）现在是关的，7890 上没有监听者，直连 200。


## 双开风控与借用锁（2026-10-15 定下的策略）

带着你的登录态开第二个浏览器，平台风控看到的是：同 IP、同一套 session cookie 在两套 profile 上并发活跃。实测豆包双开共存（他那边没被顶下线），但这是平台**今天**的策略。应对分四层，前三层是让「第二个浏览器」显得无害，第四层是干脆不要它：

1. **会话独占（默认，已实现）**：`runTask` 按白名单站点取跨进程独占锁（`%TEMP%\agent-browser-locks`，持锁进程死亡自动判定可接管），同一站点同一时刻只允许一个 agent 会话；桥的 `/status` 和 MCP 的 `cookie_source_info` 会报 `borrowedSites`。锁的诚实边界：**它只管我们自己这边**，看不见你本人在不在用——「agent 借用期间你不同时用那个站」这条纪律在你手上。
2. **把第二开长得像同一台电脑（已实现大半）**：agent 浏览器用的是你本机同版本 `chrome.exe`，同 canvas/WebGL/字体指纹；localStorage（含字节系写进 `__tea_cache_*`/`xmst` 的设备状态）现在直接从你 profile 的 leveldb 磁盘直读搬运（见下一节），不再呈「老账号新设备」形态。sessionStorage 是运行态内存，拿不到。
3. **敏感面收口（页面路径级禁区，已实现）**：`src/guard.js` 拦四类页面——支付/扣款（pay、checkout、billing、提现、充值、支付宝/微信支付入口）、账号安全与凭据（password、token、api-key、ssh-key、oauth、二次验证、sessions、logout、applications）、实名认证（kyc、realname、shiming、renzheng、verify、路径里的「实名/认证」）、账号注销（delete-account、deactivate、deletion、路径里的「注销」）。三个拦截点：`agent.page()` **goto 之前**查（实测请求根本没发出，`requests=0`）→ **goto 之后按最终 URL 复查**（站点自己 302 进禁区也算）→ 站内点链接/`location.href` 跳进禁区时由 `framenavigated` **立刻关页并记 `agent.guardViolations`**，`runTask` 的返回值里带这份账。规则是纯 glob（`*` 吃任意字符含 `/`，`?` 吃一个），其余字符一律转义，不会出现「写的规则被当正则解释了」；host 限定用 `{host, path}` 对象形。config 里 `guard: {enabled, extraDenied, allow}`，`allow` 只能精确放行某条路径（同一 URL 上别的规定仍然拦）。三条实测出来的边界：① **服务器 302 那一发的 GET 拦不住**——重定向由浏览器跟随，拿到最终 URL 时请求已经发出（`verify-guard` 该项实测 `requests=2`），拦下的是「页面停在禁区里继续操作」，不是「字节没到过」；② 同文档 SPA 路由**是**拦得住的：`history.pushState('/pay/checkout')` 和 `#/pay/...` 这类 hash 路由都会触发 `framenavigated` 并被关页记账（实测两条各 1 条 violation），但文档锚点 `#password` 不算路由，不误伤；③ **`fetch`/XHR 打禁区接口不拦**（实测页面里 `fetch('/pay/confirm')` 拿到 `status=200`，服务端收到 1 发）——这一层管的是「页面」，不是请求；要拦接口得另做一层 route 过滤，代价是把 `/static/password-icon.png` 这种资源一起拦掉，没做。

4. **干脆不要第二个环境（两条都已实现）**：① **扩展那条**（`src/user-tabs.js`）在你那个 Chrome 里开后台标签页并驱动它，凭据本来就在原地，风控看到的既不是双开也不是新设备；代价是那个标签页你看得见，所以它不进 `runTask` 默认流程、只能显式调用，它只碰扩展自己开的标签页，注入的也是一份固定操作菜单而不是任意代码。② **免插件那条**（`src/user-browser.js`）什么都不装，`chrome.exe <url>` 走 Chrome 自己的单实例 IPC 开一页，再用 Windows UIA 把选中的标签页还原回你原来那一页（实测 Chrome 会把新开的那页激活，所以这一步是必需的）。它只能开页，读不到也驱动不了那个标签页——默认 profile 上两种 DevTools 传输都被拒，这条路不带任何调试参数。两次的共同点：起的是同一个浏览器、同一套凭据，多出来的只是一个标签页。

**明确不做**：伪造 canvas/WebGL 指纹去冒充另一台「真设备」。那是检测规避军备竞赛，被识别的处罚比双开重；本项目做的是诚实的「同一台设备的第二个窗口」。

## 验证

```bash
node test/verify.js              #  9 项：HTTP 站点全链路
node test/verify-https.js        # 10 项：HTTPS + Secure/sameSite=None cookie
node test/verify-silence.js     #  7 项：真机静默与残留
node test/verify-bridge.mjs    #  17 项：扩展桥双向 + 客户端模式 + cookie/localStorage 交给 agent 浏览器
node test/verify-no-identity.mjs #  3 项：无端口/无扩展时必须明确失败
node test/verify-site-lock.mjs  # 11 项：站点借用锁
node test/verify-guard.mjs     # 45 项：路径级禁区（规则表 / glob 语义 / 真机三个拦截点 / 实测盲区）
node test/verify-extension.mjs # 15 项：agent 浏览器装载未打包扩展（拿你的 VideoDownloader 实测）
node test/verify-user-tabs.mjs # 14 项；--real 打真机（默认 5 项，加 --type 是 7 项，会往页面里写占位文字不发送）
node test/verify-localstorage.mjs # 12 项：leveldb 读取器（snappy 往返 / 合成 log / 真库只读冒烟）
node test/verify-user-browser.mjs #  7 项：免插件开页的参数形状与禁区前置（--real 时 13 项）
node test/verify-extensions.mjs  # 13 项：桥上的扩展管理（list/detail/enable/disable/reload/自保护）
node test/probe-reload-trap.mjs #  9 项：未打包扩展的 reload 陷阱与安全换版（plain 臂故意失败=结论）
node cookie-mcp/smoke.js        # 19 项：MCP 协议、三条读取路径、扩展管理工具
```

**191 项里 190 通过**（本轮逐套实跑，代理侧十套：9+10+7+3+11+45+12+15+14+7；另 `verify-bridge` 17/17、`verify-extensions` 13/13、`cookie-mcp/smoke` 19/19；`probe-reload-trap` 8/9——那 1 条失败是**结论本身**：无参数下一发 `reload()` 会让未打包扩展永久失联）。真机：`verify-user-tabs --real --type` **7/7**、`verify-user-browser --real` **13/13**。功能测试全部用**临时端口 + 临时 profile** 的 Chrome，不碰真实浏览器；只有 `verify-no-identity`、`verify-localstorage` 的真库冒烟和 MCP 的 snapshot 路径会只读你真实的 profile。`verify-user-tabs --real` 和 `verify-user-browser --real` 是显式加参数才打你正在用的浏览器：前者由扩展开一个后台标签页，后者命令行开一页再把选中位还原，跑完都会把自己开的页关掉。

`verify-bridge` 会自己主持一个桥。你装载扩展之后，跑它请换端口，否则你的浏览器和测试用的临时浏览器会抢同一份请求队列：

```bash
VERIFY_BRIDGE_PORT=8796 node test/verify-bridge.mjs
```

真机验收（打你自己的浏览器，只读，输出里没有值）：

```bash
node test/live-identity-check.mjs github.com          # 取回并列出域名/名字/长度
node test/live-identity-check.mjs github.com --use    # 再交给 agent 浏览器实测登录态
```

| 套件 | 覆盖 |
|---|---|
| `verify.js` | 抓取→恢复免登录、新 cookie 回写、轮换不顶掉用户会话、用户会话仍有效、临时 profile 无残留 |
| `verify-https.js` | TLS 传输、`Secure`+`SameSite=None`+`HttpOnly` 全字段往返、HTTPS 同源 iframe 收得到 cookie、自签站点（`ignoreHTTPSErrors` 已打通）、无 CDP 时如实报告 v20 加密而非崩溃 |
| `verify-silence.js` | 真机进程/窗口枚举：agent 浏览器起 9 个 chrome 进程但**任务栏与 Alt+Tab 零窗口**、关闭后进程全消、无临时目录残留 |
| `verify-no-identity.mjs` | 没有可用身份时任务**拒绝执行**（`taskRan=false`）、错误信息给出 `--remote-debugging-port` 修法、并报出磁盘上有哪些 cookie 名 |
| `verify-bridge.mjs` | 真 Chrome + 真扩展：CDP 装扩展（`Extensions.loadUnpacked`）、500 ms 内注册、`chrome.cookies` 取回明文、按域过滤不外泄、`Secure`+`SameSite=None` 字段往返、回写后浏览器侧读得到、第二进程转客户端复用同一桥、无 key 的轮询 401 |
| `smoke.js` | MCP 握手、tools/list、域名过滤、名字过滤、前导点父域匹配、密值必须带 `__encrypted__` 标记不外泄、扩展管理工具的动作校验与无桥时如实报错 |

已知边界（测试记录在案，非缺陷）：`127.0.0.1` 属 trustworthy origin，`http://` 下也会发 `Secure` cookie——浏览器正确行为。

真机验收（2026-10-15，你本人的 Chrome，只读）：手动「加载已解压的扩展程序」之后，`node test/live-identity-check.mjs github.com --use` 量到——

| 环节 | 实测 |
|---|---|
| 扩展注册上桥 | 46 s（无服务器期间 worker 退避到 30 s 上限，首次呼叫要等一轮）；有桥常驻时 500 ms |
| 取回 github.com cookie | **17 条，`encrypted-looking: 0`**，含 `user_session`(len 48, httpOnly)、`__Host-user_session_same_site`(48, SameSite=Strict)、`_gh_sess`(756)、`logged_in`、`dotcom_user`(7) |
| 交给 agent 浏览器 | 临时 profile 恢复 17 条，`https://github.com/` 打开后页里 `meta[name="user-login"]` = **hhgggbk** |
| 交叉验证 | 带过去的 `dotcom_user` 长度 7 与站点自报的用户名同为 7 字符——客户端侧与服务端侧说的是同一个人 |
| 你这边 | 没重启、没开端口、没弹任何窗口；脚本收尾明写「nothing was written to your browser or to disk」 |

这一发还抓出一个合成套件覆盖不到的真 bug：桥回传的 session cookie 是 `expires: null`，而 Playwright 的 `addCookies` 收到 null 直接 `expected float, got object` 抛死（CDP 那条路给的是 0，所以一直没暴露）。已在 `agent-browser.js` 里按字段归一，并给 `verify-bridge` 补了「桥 → agent 浏览器」这两条断言——**先跑真机才撞见它**，这就是为什么两套都要留着。

真机回写已于 2026-10-20 验过（见「回写规则」一节的 demo 记录），至此没有待验的块了。原先的另一块（localStorage）早经磁盘直读解决，见下一节。

## localStorage 的磁盘直读（2026-10-15）

之前断言过「localStorage 要读就必须在你的窗口里开一个该站的页」——**这个判断被推翻了**。localStorage 在 `Default/Local Storage/leveldb` 里是**明文 LevelDB**，不走 CDP、不开窗口、不加密（和 cookie 的 v20 完全两回事）。`src/localstorage-reader.js` 手写解析：`.log`（写前批）+ `.ldb`（SST 表，含 snappy 解压），按序号折叠出有效态。你真库实测：**631 个 origin、7024 个键，0 个文件解析失败**。

格式上的三个坑，都拿真库钉死过（别信旧资料）：
- 数据键是 `_<origin>\x00\x01<key>`——NUL 后还有一个 `\x01` 标记字节；
- 值的 flag 字节语义与旧文档相反：**0x01 = Latin-1，0x00 = UTF-16LE**（拿 Chrome 155 存的裸 ASCII 钉死的）；
- LevelDB 内部键尾 8 字节是 LE64(`(seq<<8)|type`)，**type 在最低字节**——读错字节会把全库判成墓碑。

局限：sessionStorage 是运行态内存，磁盘上没有；Chrome 落盘有 ~1 秒惰性提交。桥路径的 `storages` 现在从这里来（`whitelist.captureLocalStorage: false` 可关）。

## MCP 的读取路径

| 路径 | 触发条件 | 值 |
|---|---|---|
| `extension-bridge` | 装载了 `cookie-extension`（默认 profile 也能用） | **明文，Chrome 自己解密；localStorage 从磁盘直读** |
| `live` | 有 CDP 端口（只能是非默认 profile） | 明文，且额外给 sessionStorage |
| `snapshot` | 上面两条都没有 | 元数据准，值带 `__encrypted__` 前缀 |

按这个顺序试。没有「拷 profile 让新 Chrome 解密」那条——实测否决并从代码中移除，原因见上面那节。



## 明确不做

- Identity Vault 产品化、无地址栏浏览器发行版、camoufox 双内核。
- **扩展路径已从「不做」改成「主路径」**：PLAN.md 第七节当时判定它相对 CDP 冗余，而实测 Chrome 136+ 拒绝在默认 profile 上开调试端口——CDP 恰恰对日常那个浏览器不可用。判定被测量推翻了，理由记在这里。
- MITM 注入代理（计划书里的 F1 候选）：需要装根证书，系统级改动。当前实现走 CDP 恢复而非代理注入，规避了证书问题；银行/证书 pinning 站点仍不支持。
- 不去解 v20 app-bound 密文。那需要打 Chrome 提权 COM 服务的调用方校验，做出来是一个通用 cookie 窃取原语，不止对你这台机器生效——不是你这次需求的必要环节。
- **禁区不做请求级过滤**（fetch/XHR）。按路径拦所有请求会连带拦掉 `/static/password-icon.png` 这类同名资源，且「接口没被拦」和「页面没进去」是两件事：这一层的语义是「agent 不会站在支付页/改密码页上替你点」，实测盲区由 `verify-guard` 里那条 `fetch() to a禁区 path is NOT blocked` 钉住，不假装它不存在。

## 文件

| 文件 | 职责 |
|---|---|
| `src/bridge.js` | 身份桥：本机 HTTP + 扩展长轮询；端口被占时转客户端 |
| `src/user-tabs.js` | 在你自己的浏览器里开后台标签页并驱动它（走桥，只碰扩展自己开的 tab） |
| `src/extensions.js` | 桥上的扩展管理封装：list/find/detail/enable/disable/reload/uninstall/loadUnpacked |
| `src/user-browser.js` | 免插件在你浏览器里开一页：`chrome.exe <url>` 单实例 IPC，开完把选中位还原；禁区前置 |
| `src/win-tabs.js` | Windows UIA 看 Chrome 标签栏：`TabContainerImpl` 定位、选回标签、关自己开的页、前台窗口三级阶梯 |
| `cookie-extension/` | MV3 扩展，`chrome.cookies` 双向，只连 127.0.0.1 |
| `src/capture.js` | 三条路：CDP 实时 → 扩展桥 → 离线 profile 探测 |
| `src/localstorage-reader.js` | 零依赖 LevelDB 读取器：localStorage 磁盘直读（log + ldb + snappy） |
| `src/site-lock.js` | 站点借用锁：同站同时只允许一个 agent 会话 |
| `src/guard.js` | 路径级禁区：支付/账号安全/实名/注销四类页面的 glob 规则表与匹配器 |
| `src/vault.js` | 内存身份库，TTL，域过滤（host 带端口已处理） |
| `src/agent-browser.js` | headless agent 浏览器，临时 profile，退出即删；按需 CDP 装载未打包扩展 |
| `src/writeback.js` | 增量回写 diff（两条路共用同一套规则） |
| `src/broker.js` | 串起 capture → restore → task → writeback → wipe |
| `test/verify.js` | 端到端 9 断言 |
| `test/verify-guard.mjs` | 路径级禁区 45 断言 |
| `test/verify-extension.mjs` | 扩展装载与驱动 15 断言（实测对象：你的 VideoDownloader） |
