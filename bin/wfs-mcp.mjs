#!/usr/bin/env node
/**
 * wfs-mcp —— MCP server 入口 + CLI 子命令
 *
 * 不带参数时：起 stdio MCP server（客户端拉起的标准用法）
 * 带子命令时：跑对应的运维脚本
 *
 *   wfs-mcp                    起 MCP server
 *   wfs-mcp install [...]      写各 agent 的 MCP 配置
 *   wfs-mcp daemon <cmd>       daemon 开机自启管理
 *   wfs-mcp doctor             环境自检
 *   wfs-mcp selftest           MCP 协议层自测
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const cmd = process.argv[2];

const SCRIPTS = {
  install: "install.mjs",
  daemon: "daemon.mjs",
  doctor: "doctor.mjs",
  selftest: "selftest.mjs",
};

if (cmd && SCRIPTS[cmd]) {
  const script = path.join(ROOT, "scripts", SCRIPTS[cmd]);
  if (!existsSync(script)) {
    process.stderr.write(`[wfs-mcp] 找不到脚本：${script}\n`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [script, ...process.argv.slice(3)], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (cmd && cmd !== "start" && cmd !== "--help" && cmd !== "-h") {
  process.stderr.write(
    `未知命令：${cmd}\n可用：${Object.keys(SCRIPTS).join(" / ")}（不带参数则起 MCP server）\n`,
  );
  process.exit(1);
} else {
  const { startStdio } = await import("../src/server.mjs");
  startStdio().catch((e) => {
    process.stderr.write(`[wfs-mcp] 启动失败：${e?.stack || e}\n`);
    process.exit(1);
  });
}
