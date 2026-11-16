/**
 * MCP 适配层自测。
 *
 * 真正起一个 MCP client，通过 stdio 连上 MCP server，逐个调工具，
 * 确认「协议层通 + daemon 转发通」。
 *
 * 用法：
 *   node scripts/selftest.mjs            # 只测不消耗额度
 *   node scripts/selftest.mjs --submit   # 额外真提交一条（消耗额度，慎用）
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive, baseUrl } from "../src/daemon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "bin", "wfs-mcp.mjs");
const wantSubmit = process.argv.includes("--submit");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

function line(icon, name, detail = "") {
  console.log(`${icon} ${name}${detail ? ` ${DIM}${detail}${OFF}` : ""}`);
}

let failed = 0;

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content?.[0]?.text ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {}
  return { isError: Boolean(res.isError), body, parsed };
}

async function main() {
  console.log(`\n▌ wfs-mcp 自测  ${DIM}${new Date().toLocaleString("zh-CN")}${OFF}`);
  console.log(`  daemon ${baseUrl()} → ${(await isAlive()) ? "在线" : "离线"}`);
  console.log("");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: "pipe",
  });
  const client = new Client({ name: "wfs-selftest", version: "1.0.0" });

  try {
    await client.connect(transport);
    line(GREEN + "✓", "MCP 握手成功", "stdio transport");
  } catch (e) {
    line(RED + "✗", "MCP 握手失败", e.message);
    process.exit(1);
  }

  // 1. 工具清单
  const { tools } = await client.listTools();
  const expected = [
    "wfs_status",
    "wfs_generate",
    "wfs_tasks",
    "wfs_task",
    "wfs_accounts",
    "wfs_sync",
    "wfs_doctor",
  ];
  const missing = expected.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length) {
    line(RED + "✗", "工具缺失", missing.join(", "));
    failed++;
  } else {
    line(GREEN + "✓", "工具齐全", `${tools.length} 个：${expected.join(", ")}`);
  }

  // 2. 只读工具逐个试
  const readOnly = [
    ["wfs_doctor", {}],
    ["wfs_status", {}],
    ["wfs_tasks", {}],
    ["wfs_accounts", { action: "list" }],
  ];
  for (const [name, args] of readOnly) {
    const r = await call(client, name, args);
    if (r.isError) {
      const reason = r.parsed?.code || "unknown";
      // daemon 离线是可预期的，不是代码 bug
      if (reason === "daemon_offline") {
        line(DIM + "·", name, "daemon 离线（跳过）");
      } else {
        line(RED + "✗", name, r.body.slice(0, 160));
        failed++;
      }
    } else {
      line(GREEN + "✓", name, summarize(r.parsed));
    }
  }

  // 3. 查一个不存在的任务 —— 必须优雅返回而不是抛错
  const miss = await call(client, "wfs_task", { upstreamId: "wfs-selftest-not-exist" });
  if (miss.isError) {
    line(RED + "✗", "wfs_task 容错", miss.body.slice(0, 160));
    failed++;
  } else {
    line(GREEN + "✓", "wfs_task 容错", "不存在的 id 优雅返回");
  }

  // 4. 参数校验 —— 空 prompt 必须被拒
  const bad = await call(client, "wfs_generate", { provider: "veda", prompt: "" });
  if (bad.isError) {
    line(GREEN + "✓", "wfs_generate 参数校验", "空 prompt 被拒");
  } else {
    line(RED + "✗", "wfs_generate 参数校验", "空 prompt 竟然通过了");
    failed++;
  }

  // 5. 真提交（可选）
  if (wantSubmit) {
    const prompt =
      "A cinematic close-up of rain hitting a neon-lit street at night, water droplets running down glass, shallow depth of field, moody teal and magenta reflections, slow dolly forward";
    const r = await call(client, "wfs_generate", { provider: "veda", prompt, duration: 5, aspect: "16:9" });
    if (r.isError) {
      line(RED + "✗", "wfs_generate 真提交", r.body.slice(0, 200));
      failed++;
    } else {
      line(GREEN + "✓", "wfs_generate 真提交", `upstreamId=${r.parsed?.upstreamId}`);
    }
  } else {
    line(DIM + "·", "wfs_generate 真提交", "跳过（加 --submit 才跑）");
  }

  console.log("");
  if (failed) {
    console.log(`${RED}✗ ${failed} 项未通过${OFF}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ 全部通过${OFF}\n`);
  process.exit(0);
}

function summarize(p) {
  if (!p) return "";
  if (p.daemon) return `daemon ${p.daemon.alive ? "在线" : "离线"}`;
  if (p.count != null) return `${p.count} 条任务`;
  if (p.accounts) return `${p.accounts.length} 个账号`;
  return "";
}

main().catch((e) => {
  console.error(`${RED}自测异常${OFF}`, e);
  process.exit(1);
});
