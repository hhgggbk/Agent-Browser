---
name: agent-browser
description: 用 Agent-Browser 这一个 MCP（门面 agent_browser，63 工具）在真实浏览器里干活：可见/静默浏览、借用户 Chrome 的登录态、读 cookie、抓网络与样式、在页面里跑 JS、断点逆向、录屏与性能审计。当用户说「打开/浏览某站」「用我的浏览器」「要登录态」「抓个请求」「这页的样式/接口」「逆向这段 JS」时使用。
when_to_use: 任何需要在真实浏览器里取页面数据、复刻界面或接口、借用登录态、调试前端脚本的任务；不确定走哪条浏览器通道时
---

# Agent-Browser：一个 MCP，三条后端

`agent_browser` 由 `src/mcp.js` 把三个 stdio 后端合成一条注册：

| 后端 | 工具 | 干什么 |
|---|---|---|
| devtools（chrome-devtools-mcp 1.11） | 32 个，无前缀 | 页面、快照、样式、网络、性能、录屏、模拟、对话框、上传 |
| identity（cookie-mcp + 扩展桥） | 5 个：`cookie_source_info` `list_cookie_domains` `get_cookies` `list_extensions` `extension_manage` | 用户自己那个 Chrome 的 cookie 与扩展 |
| js-reverse | 26 个，全 `jsr_` 前缀 | 脚本源码、断点、暂停、单步、沙箱、反混淆、WebSocket |

工具清单以 `mcp_list({keyword:"agent_browser"})` 为准，签名不清先 `mcp_get`，别凭印象写名字。用户级 `js-reverse` 仍单独注册着，`jsr_*` 是同一套工具的第二份入口。

## 第 0 步：选通道（选错就白干）

| 需求 | 通道 |
|---|---|
| 不要登录态，只要页面内容 | agent 自己的浏览器（devtools 那 32 个），匿名起步 |
| 要登录态，能接受第二个浏览器环境 | `capture.enabled=true` 把 cookie 灌进 agent 浏览器；只灌**已落盘**的，未落盘的会话 cookie 拿不到 |
| 要登录态且风控敏感，必须待在用户那个 Chrome 里 | 用户自己的 Chrome + 扩展桥（`src/user-tabs.js`）：后台标签、固定菜单驱动，不抢焦点 |
| 要页面自己的全局、断点、加密入口 | `jsr_*`（同一套 CDP，换逆向视角） |
| 已经有一个 Chromium 在跑（Chrome/Edge/Quark…），只想借它的调试口 | 启动时带 `--remote-debugging-port=<port>`，再把门面的 `AGENT_BROWSER_CDP_URL=http://127.0.0.1:<port>` 设上（实测 Quark 7.4.2 / Chrome 144，20 项全过） |
| 只要样式/接口证据来复刻 | 先看 `web-replica` skill 的四步流程 |

## 第 1 步：开关与闸门（默认全关）

- `agent.silent`、`cdp.enabled`、`capture.enabled` 在 `config/default.json` 里都是 `false`；要打开必须用户点名，别替用户开。
- `get_cookies` / `list_cookie_domains` 另有 env 闸门 `AGENT_BROWSER_ALLOW_COOKIE_ACCESS=1`。关闭时它们回 `COOKIE_ACCESS_DISABLED` 并说明原因，`cookie_source_info` 会报 `cookieAccess:{enabled,note}`。
- 路径级禁区 `src/guard.js`（支付、改密/凭据、实名、注销）不许绕过，也不许把目标路径塞进 `guard.allow`。
- `AGENT_BROWSER_CDP_URL` 接已有浏览器（设了就不再启动自己的 profile）；`AGENT_BROWSER_WORKSPACE=<dir>` 放开文件写入。**不设 workspace 时只有 OS 临时目录可写，而且客户端若不支持 MCP `roots`，`take_screenshot({filePath})` 会一直等 roots 回答，把整条 devtools 后端卡死**（实测 60 s 超时，之后的调用全部连带超时）；不带 `filePath` 的截图是内联返回，不受影响。

读 cookie 的三条现实：磁盘 + v20 密文只能看到**已落盘**的项，值是 `__encrypted__` 就说明 Chrome 没暴露明文；唯一拿明文的路是扩展桥；扩展只在 **30 秒保活闹钟**醒来时向桥报到，`connected:false` 不代表坏了，等一轮再判。`list_cookie_domains` 已知缺陷：不走桥时读磁盘会撞 Chrome 文件锁（EBUSY）。

## 第 2 步：配方（任务 → 工具序列）

**读一页**：`list_pages` → `new_page` / `navigate_page` → `wait_for({pageId, text:["…"]})` → `take_snapshot`（拿 uid）→ `take_screenshot`。
`wait_for` 只认**页面文字**，没有 selector 参数；要等元素就小间隔轮询 `evaluate_script`，不要拍固定秒数。

**填表/点击**：`take_snapshot` 拿 uid → `fill` / `fill_form` → `click` → `wait_for` 验结果。受控组件（React/Vue）或 contenteditable 若回读值不对，改用 `evaluate_script` 走原生 setter + `input`/`change` 事件。

**取样式**：`take_snapshot` → `get_css_styles({pageId, uid, pageIdx})` 出完整层叠（赢的裸写、被覆盖标 `[overloaded]`、带源行号、每页 10 条要翻页）。

**抓接口**：`list_network_requests` → `get_network_request({reqid, requestFilePath, responseFilePath})` 把请求/响应体落盘再看（省 token，也能看到 `Cookie`/`Set-Cookie` 头）。

**页面内跑 JS**：`evaluate_script` 跑在隔离世界，拿不到页面全局；要调 app 自己的全局用 `jsr_evaluate_script({mainWorld:true})`（例 `FG.setTool('move')`）。全局不存在时先怀疑世界选错了。

**逆向/加密**：`jsr_list_scripts` → `jsr_get_script_source` / `jsr_save_script_source` → `jsr_set_breakpoint_on_text` → `jsr_get_paused_info` → `jsr_step`；静态反混淆走 `jsr_deobfuscate`（webcrack+wakaru，30 MB 上限）；只跑算法用 `jsr_run_in_sandbox`（jsdom 补环境，沙箱里没有 `Buffer`）。

**复用登录态**：`cookie_source_info` 看桥 → `get_cookies({domains:["site.com"]})`（一个域覆盖其子域）→ 把结果交给目标浏览器。`list_extensions` / `extension_manage({action,target,path})` 管用户 Chrome 里的扩展。

**其它**：`lighthouse_audit`；`performance_start_trace` → `performance_stop_trace` → `performance_analyze_insight`；`take_heapsnapshot`；`screencast_start`/`screencast_stop`；`emulate`（设备/网络/UA）；`handle_dialog`；`upload_file`；`resize_page`。

## 第 3 步：验收与已知坑

- **改扩展代码后**，`extension_manage({action:"reload"})` 不保证重读磁盘（Chrome 155 实测 `chrome.runtime.reload()` 一次就终、worker 不再回来）；要生效去 `chrome://extensions` 手动「重新加载」，改完必须用新能力探一次再说生效。
- **Chrome 136+ 拒绝在默认 profile 上开 `--remote-debugging-port`**；agent 浏览器用自己的 profile，所以这条路合法。
- **`document.querySelector` 穿不进 shadow root**：open root 靠桥的 `deepQueryAll`（扩展重载后才生效），closed root 只剩 CDP `DOM.getDocument(pierce:true)` 或 Windows UIA。
- **别把「看不到」当「不存在」**：`innerHTML` 不序列化 shadow 内容；cookie 看不到往往是还没落盘。
- **uid 会失效**：`get_css_styles`/`fill`/`click` 用的 uid 来自最近一次 `take_snapshot`，页面 DOM 一变（哪怕是填了个输入框）旧 uid 就可能查不到；要样式就连着快照一起问。
- 成本（实测）：冷开到截图 5~6 s，硬底 3.4 s；常驻 agent 浏览器省约 3.3 s/次。

## 别做

- 不为省事打开 `silent` / `cdp` / `capture`，或把 `AGENT_BROWSER_ALLOW_COOKIE_ACCESS` 设成 1——那是用户的决定。
- 不用固定 sleep 等页面，也不把「没等到」直接判成「页面坏了」。
- 不把 cookie 值、token、Authorization 头打进对话或日志；只要名字、长度、布尔。
