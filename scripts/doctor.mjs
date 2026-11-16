#!/usr/bin/env node
/**
 * 换机自检：一条命令看清「能不能用」。
 *
 * 检查项：
 *   1. Node 版本
 *   2. daemon 是否在线（端口 + 健康接口）
 *   3. web-free-studio 目录是否就位
 *   4. Paba 账号池状态
 *   5. Veda 额度读数
 *   6. 各 agent 的 MCP 配置是否写入
 *   7. 已知坑位提示
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { get, isAlive, baseUrl } from "../src/daemon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const SERVER_NAME = "web-free-studio";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", off: "\x1b[0m" };

let problems = 0;

function ok(msg) {
  console.log(`  ${C.g}✓${C.off} ${msg}`);
}
function warn(msg) {
  console.log(`  ${C.y}!${C.off} ${msg}`);
}
function bad(msg) {
  console.log(`  ${C.r}✗${C.off} ${msg}`);
  problems++;
}
function info(msg) {
  console.log(`  ${C.d}·${C.off} ${msg}`);
}

async function findStudioRoot() {
  const cands = [
    process.env.WFS_ROOT,
    path.resolve(HERE, "..", ".."),
    path.join(HOME, "Desktop", "REA", "web-free-studio"),
    path.join(HOME, "projects", "web-free-studio"),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      await fs.access(path.join(c, "server", "cli.mjs"));
      return c;
    } catch {}
  }
  return null;
}

async function checkMcpConfigs() {
  const targets = [
    ["workbuddy", path.join(HOME, ".workbuddy", "mcp.json"), "json"],
    ["codex", path.join(HOME, ".codex", "config.toml"), "toml"],
    ["claude", path.join(HOME, ".claude.json"), "json"],
    ["cursor", path.join(HOME, ".cursor", "mcp.json"), "json"],
  ];
  for (const [name, file, kind] of targets) {
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      info(`${name}：配置不存在（没装这个 agent，跳过）`);
      continue;
    }
    const hit = kind === "json" ? text.includes(`"${SERVER_NAME}"`) : text.includes(`mcp_servers.${SERVER_NAME}`);
    if (hit) ok(`${name}：MCP 已配置`);
    else warn(`${name}：文件在但没配 wfs-mcp，跑 node scripts/install.mjs --target ${name}`);
  }
}

async function main() {
  console.log(`\n▌ web-free-studio 自检  ${C.d}${new Date().toLocaleString("zh-CN")}${C.off}\n`);

  console.log(`${C.b}运行环境${C.off}`);
  const major = Number(process.version.slice(1).split(".")[0]);
  if (major >= 22) ok(`Node ${process.version}`);
  else bad(`Node ${process.version} —— 需要 >= 22`);

  const root = await findStudioRoot();
  if (root) ok(`studio 目录：${root}`);
  else bad("找不到 web-free-studio 目录（设 WFS_ROOT 环境变量）");

  console.log(`\n${C.b}daemon${C.off}`);
  const alive = await isAlive();
  if (alive) ok(`daemon 在线：${baseUrl()}`);
  else {
    bad(`daemon 离线：${baseUrl()}`);
    console.log(`    ${C.d}启动：cd ${root || "<web-free-studio>"} && npm start${C.off}`);
    console.log(`    ${C.d}或装开机自启：node scripts/daemon.mjs install${C.off}`);
  }

  if (alive) {
    console.log(`\n${C.b}上游状态${C.off}`);
    const state = await get("/api/state").catch((e) => ({ error: e.message }));
    if (state.error) {
      warn(`Paba 状态读取失败：${state.error}`);
    } else {
      const accounts = state.accounts || [];
      const online = accounts.filter((a) => a.status === "online" && !a.disabled);
      ok(`Paba 账号 ${accounts.length} 个（可用 ${online.length}）`);
      for (const a of accounts) {
        const mark = a.disabled ? `${C.d}停用${C.off}` : a.status === "online" ? `${C.g}在线${C.off}` : `${C.y}${a.status}${C.off}`;
        console.log(`      ${String(a.label).padEnd(10)} ${mark}  ${C.d}今日 ${a.usage?.consumed ?? "?"}/${a.usage?.limit ?? "?"} · 在途 ${a.active ?? 0}${C.off}`);
        if (a.needsChallenge) warn(`${a.label} 需要人机验证`);
        if (a.lastError) info(`${a.label} 错误：${a.lastError}`);
      }
      const totalLeft = accounts.reduce((s, a) => s + (a.usage?.left ?? 0), 0);
      console.log(`      ${C.d}Paba 剩余额度合计 ${totalLeft} 条${C.off}`);
    }

    const veda = await get("/api/veda/state").catch((e) => ({ error: e.message }));
    if (veda.error) {
      warn(`Veda 状态读取失败：${veda.error}`);
    } else if (veda.ok) {
      const q = veda.quota || {};
      ok(`Veda 额度 ${q.used ?? "?"}/${q.limit ?? "?"}，剩余 ${q.remaining ?? "?"} credit`);
      if (q.resetsAt) info(`额度恢复时间：${new Date(q.resetsAt).toLocaleString("zh-CN")}`);
      console.log(`      ${C.d}单条成本：${JSON.stringify(q.costs || {})}（5s=1 / 10s=2 / 15s=3）${C.off}`);
      console.log(`      ${C.d}今日已提交 ${veda.local?.submittedToday ?? "?"}/${veda.local?.networkDailyLimit ?? 30}（同网络上限），在途 ${veda.local?.active ?? "?"}${C.off}`);
    } else {
      warn(`Veda 不可用：${veda.error || "未知原因"}`);
    }
  }

  console.log(`\n${C.b}MCP 配置${C.off}`);
  await checkMcpConfigs();

  console.log(`\n${C.b}已知坑位${C.off}`);
  console.log(`  ${C.d}· Veda 额度按「出口 IP」计，换设备 / 清 cookie 都无效${C.off}`);
  console.log(`  ${C.d}· Veda prompt 至少 32 字符，且校验必须打在用户原文上${C.off}`);
  console.log(`  ${C.d}· 只有 minimax-h3-flash 是免费模型，选别的会扣积分${C.off}`);
  console.log(`  ${C.d}· Paba 必须走真实浏览器（TLS 指纹 + Turnstile），纯 fetch 会被 403${C.off}`);
  console.log(`  ${C.d}· 单实例：多个 daemon 会互相覆盖本地库，端口被占时先停旧的${C.off}`);

  console.log("");
  if (problems) {
    console.log(`${C.r}✗ ${problems} 项需要处理${C.off}\n`);
    process.exit(1);
  }
  console.log(`${C.g}✓ 一切正常${C.off}\n`);
}

main().catch((e) => {
  console.error(`${C.r}自检异常${C.off}`, e);
  process.exit(1);
});
