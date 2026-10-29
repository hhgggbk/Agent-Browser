// Generate the project-scoped MCP registration for the agent-browser front door
// (src/mcp.js), which serves the cookie/extension tools AND the DevTools tools
// under one server name.
//
// Why a generator instead of a checked-in .mcp.json: Qoder reads the project
// file at <项目根>/.qoder/.mcp.json and the entry needs absolute paths, so the
// file a developer's machine produces is machine-specific by nature. Shipping
// this script is what makes the project portable.
//
//   node scripts/mcp-install.mjs            写入 <项目根>/.qoder/.mcp.json
//   node scripts/mcp-install.mjs --parent   同时写上一层目录（把父目录当项目根打开时才需要）
//   node scripts/mcp-install.mjs --dry-run  只打印，不落盘
//   node scripts/mcp-install.mjs --js-reverse <js-reverse-mcp 的 build/src/index.js>
//       把 js-reverse 也并进来（它的 26 个工具会统一加 jsr_ 前缀，因为和 DevTools 有 7 个同名）；
//       不给这个参数就是发布默认的两条后端。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");
const doorJs = path.join(projectRoot, "src", "mcp.js");
const pkgDir = path.join(projectRoot, "node_modules", "chrome-devtools-mcp");
const binJs = path.join(pkgDir, "build", "src", "bin", "chrome-devtools-mcp.js");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const withParent = argv.includes("--parent");
const jsrIdx = argv.indexOf("--js-reverse");
const jsReverseEntry = jsrIdx >= 0 ? path.resolve(argv[jsrIdx + 1] || "") : "";

for (const [label, p] of [["src/mcp.js", doorJs], ["chrome-devtools-mcp 的入口", binJs]]) {
  if (!fs.existsSync(p)) {
    console.error(`${label} 不在：${p}\n先跑 npm install 再重试。`);
    process.exit(1);
  }
}
if (jsReverseEntry && !fs.existsSync(jsReverseEntry)) {
  console.error(`--js-reverse 指向的文件不在：${jsReverseEntry}`);
  process.exit(1);
}

// 注意：这里不写 AGENT_BROWSER_ALLOW_COOKIE_ACCESS。发布默认就是「拿不到 cookie」，
// 要放开由使用者自己往 env 里加一行。
const env = { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" };
if (jsReverseEntry) env.AGENT_BROWSER_JS_REVERSE_ENTRY = jsReverseEntry;

const config = {
  mcpServers: {
    "agent-browser": {
      type: "stdio",
      command: process.execPath,
      args: [doorJs],
      cwd: projectRoot,
      env,
    },
  },
};

const targets = [path.join(projectRoot, ".qoder", ".mcp.json")];
if (withParent) targets.push(path.join(path.dirname(projectRoot), ".qoder", ".mcp.json"));
const body = JSON.stringify(config, null, 2) + "\n";

for (const file of targets) {
  if (dryRun) {
    console.log(`# ${file}\n${body}`);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  console.log(`wrote ${file}`);
}

console.log(
  `\n生效条件：Qoder 只在「以该目录为项目根打开的会话」里读取 .qoder/.mcp.json，` +
  `所以 ${withParent ? "两个根都覆盖了" : `要覆盖 ${path.basename(projectRoot)}，会话就开在它上面`}；` +
  `会话中途写的文件不会热进已经在跑的会话。`
);
