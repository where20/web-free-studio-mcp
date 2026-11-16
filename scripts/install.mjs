#!/usr/bin/env node
/**
 * 一键安装：把 web-free-studio-mcp 写进各 agent 的 MCP 配置。
 *
 * 支持的目标（存在的才写）：
 *   workbuddy  ~/.workbuddy/mcp.json                { mcpServers: { name: {command,args} } }
 *   codex      ~/.codex/config.toml                 [mcp_servers.name]  command/args
 *   claude    ~/.claude.json                        { mcpServers: { name: {...} } }
 *   cursor     ~/.cursor/mcp.json                   { mcpServers: { name: {...} } }
 *
 * 用法：
 *   node scripts/install.mjs                 # 检测并写入所有已存在的目标
 *   node scripts/install.mjs --all           # 连不存在的目标也创建
 *   node scripts/install.mjs --target codex  # 只写某一个
 *   node scripts/install.mjs --stdio         # 用本地绝对路径代替 npx（更稳）
 *   node scripts/install.mjs --dry-run       # 只打印不写
 *   node scripts/install.mjs --uninstall     # 移除配置
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const HOME = os.homedir();

const SERVER_NAME = "web-free-studio";
const BIN = path.join(PKG_ROOT, "bin", "wfs-mcp.mjs");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DRY = has("--dry-run");
const ALL = has("--all");
const UNINSTALL = has("--uninstall");
const ONLY = val("--target");
const USE_STDIO = has("--stdio") || process.env.WFS_INSTALL_MODE === "stdio";

const C = {
  g: "\x1b[32m",
  y: "\x1b[33m",
  r: "\x1b[31m",
  d: "\x1b[2m",
  b: "\x1b[1m",
  off: "\x1b[0m",
};

/** MCP server 启动配置 */
function serverEntry() {
  if (USE_STDIO) {
    // 直接用本地 node 跑本地文件：离线可用、启动快、不依赖 npm 缓存
    return { command: process.execPath, args: [BIN] };
  }
  // npx 从 GitHub 拉：换电脑只要改这一行
  return { command: "npx", args: ["-y", "github:where20/web-free-studio-mcp"] };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/* ------------------------------------------------------------------ *
 * JSON 型目标：workbuddy / claude / cursor
 * ------------------------------------------------------------------ */

async function applyJsonTarget(name, file, { create }) {
  const existsFile = await exists(file);
  if (!existsFile && !create) {
    return { name, status: "skip", reason: "配置不存在" };
  }
  const data = (await readJson(file)) || {};
  if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};

  if (UNINSTALL) {
    if (!data.mcpServers[SERVER_NAME]) {
      return { name, status: "skip", reason: "本来就没有" };
    }
    delete data.mcpServers[SERVER_NAME];
    if (!DRY) await writeJson(file, data);
    return { name, status: "ok", file, action: "removed" };
  }

  const had = Boolean(data.mcpServers[SERVER_NAME]);
  data.mcpServers[SERVER_NAME] = serverEntry();
  if (!DRY) await writeJson(file, data);
  return { name, status: "ok", file, action: had ? "updated" : "added" };
}

/* ------------------------------------------------------------------ *
 * TOML 型目标：codex
 * ------------------------------------------------------------------ */

function tomlEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 只替换 [mcp_servers.<name>] 那一段，不动文件其余部分 */
function upsertCodexToml(text, entry) {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const body = [
    header,
    `command = "${tomlEscape(entry.command)}"`,
    `args = [${entry.args.map((a) => `"${tomlEscape(a)}"`).join(", ")}]`,
    "",
  ].join("\n");

  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    // 插到最后一个 [mcp_servers.*] 之后，或文件末尾
    const lastMcp = lines.reduce((acc, l, i) => (l.trim().startsWith("[mcp_servers.") ? i : acc), -1);
    const at = lastMcp >= 0 ? lastMcp + 1 : lines.length;
    lines.splice(at, 0, body);
    return lines.join("\n");
  }

  // 找这一段的结束（下一个 [ 开头）
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("[")) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start, ...body.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")));
  return lines.join("\n");
}

function removeCodexToml(text) {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("[")) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start);
  return lines.join("\n");
}

async function applyCodex({ create }) {
  const file = path.join(HOME, ".codex", "config.toml");
  const existsFile = await exists(file);
  if (!existsFile && !create) {
    return { name: "codex", status: "skip", reason: "config.toml 不存在" };
  }
  const text = existsFile ? await fs.readFile(file, "utf8") : "";

  if (UNINSTALL) {
    const out = removeCodexToml(text);
    if (out === text) return { name: "codex", status: "skip", reason: "本来就没有" };
    if (!DRY) await fs.writeFile(file, out, "utf8");
    return { name: "codex", status: "ok", file, action: "removed" };
  }

  const out = upsertCodexToml(text, serverEntry());
  if (!DRY) await fs.writeFile(file, out, "utf8");
  return { name: "codex", status: "ok", file, action: "updated" };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const TARGETS = [
  { name: "workbuddy", fn: () => applyJsonTarget("workbuddy", path.join(HOME, ".workbuddy", "mcp.json"), { create: ALL }) },
  { name: "codex", fn: () => applyCodex({ create: ALL }) },
  { name: "claude", fn: () => applyJsonTarget("claude", path.join(HOME, ".claude.json"), { create: ALL }) },
  { name: "cursor", fn: () => applyJsonTarget("cursor", path.join(HOME, ".cursor", "mcp.json"), { create: ALL }) },
];

const mode = UNINSTALL ? "卸载" : "安装";
console.log(`\n▌ web-free-studio MCP ${mode}`);
console.log(`  模式：${USE_STDIO ? "本地 stdio（绝对路径）" : "npx github:where20/web-free-studio-mcp"}`);
if (DRY) console.log(`  ${C.y}dry-run：只打印不写${C.off}`);
console.log("");

const results = [];
for (const t of TARGETS) {
  if (ONLY && ONLY !== t.name) continue;
  try {
    results.push(await t.fn());
  } catch (e) {
    results.push({ name: t.name, status: "error", reason: e.message });
  }
}

console.log("  目标            结果      说明");
console.log("  " + "─".repeat(58));
for (const r of results) {
  const icon = r.status === "ok" ? `${C.g}✓${C.off}` : r.status === "skip" ? `${C.d}·${C.off}` : `${C.r}✗${C.off}`;
  const st = r.status === "ok" ? `${C.g}${r.action}${C.off}` : r.status === "skip" ? `${C.d}跳过${C.off}` : `${C.r}失败${C.off}`;
  const detail = r.file ? `${r.file}${r.reason ? ` · ${r.reason}` : ""}` : r.reason || "";
  console.log(`  ${r.name.padEnd(14)}  ${icon} ${st.padEnd(16)} ${C.d}${detail}${C.off}`);
}

console.log("");
const ok = results.filter((r) => r.status === "ok");
if (ok.length) {
  console.log(`${C.b}下一步${C.off}`);
  console.log(`  1. 启动 daemon（工具才连得上）：cd <web-free-studio> && npm start`);
  console.log(`  2. 重启对应 agent 客户端`);
  console.log(`  3. 验证：node ${path.join(PKG_ROOT, "scripts", "selftest.mjs")}`);
  if (ok.some((r) => r.name === "workbuddy")) {
    console.log(`  ${C.y}·${C.off} WorkBuddy 需在连接器管理页右上角点「信任」才会生效`);
  }
  console.log("");
}
