#!/usr/bin/env node
/**
 * daemon 生命周期管理：安装 / 卸载 launchd 开机自启。
 *
 * macOS 用 launchd（LaunchAgents），Linux 走 systemd --user（可选）。
 *
 * 用法：
 *   node scripts/daemon.mjs install    # 装开机自启 + 立即启动
 *   node scripts/daemon.mjs uninstall  # 卸载
 *   node scripts/daemon.mjs status     # 看状态
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

/**
 * 找 web-free-studio 根目录（含 server/cli.mjs 的那个）。
 * 优先看环境变量，其次按相对关系推，最后在本机常见位置里找。
 */
async function findStudioRoot() {
  const cands = [];
  if (process.env.WFS_ROOT) cands.push(process.env.WFS_ROOT);
  // mcp/ 与 server/ 同级 → 上两级
  cands.push(path.resolve(HERE, "..", ".."));
  cands.push(path.join(HOME, "Desktop", "REA", "web-free-studio"));
  cands.push(path.join(HOME, "projects", "web-free-studio"));
  cands.push(path.join(HOME, "web-free-studio"));

  for (const c of cands) {
    try {
      await fs.access(path.join(c, "server", "cli.mjs"));
      return c;
    } catch {}
  }
  return null;
}

const LABEL = "com.where20.web-free-studio";
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);

function plistContent(root) {
  const nodeBin = process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${path.join(root, "server", "cli.mjs")}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${root}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(root, "data", "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(root, "data", "daemon.err.log")}</string>
</dict>
</plist>
`;
}

async function isRunning() {
  try {
    const { stdout } = await exec("launchctl", ["list", LABEL]);
    return stdout.trim().split("\n")[1]?.trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  const cmd = process.argv[2] || "status";
  const root = await findStudioRoot();

  if (cmd === "status") {
    const pid = await isRunning();
    console.log(`\n▌ daemon 状态`);
    console.log(`  studio 根目录 : ${root || "未找到（设 WFS_ROOT 环境变量）"}`);
    console.log(`  launchd 标签  : ${LABEL}`);
    console.log(`  运行状态      : ${pid ? `运行中 (pid ${pid})` : "未运行"}`);
    console.log(`  plist         : ${(await fs.access(PLIST).then(() => true).catch(() => false)) ? PLIST : "未安装"}`);
    console.log("");
    return;
  }

  if (!root) {
    console.error(`✗ 找不到 web-free-studio 目录。设 WFS_ROOT=/path/to/web-free-studio 后重试。`);
    process.exit(1);
  }

  if (cmd === "install") {
    await fs.mkdir(path.dirname(PLIST), { recursive: true });
    await fs.writeFile(PLIST, plistContent(root), "utf8");
    // 新版 macOS 的 launchctl load 已废弃，用 bootstrap；受限环境会失败
    let loaded = false;
    let err = "";
    try {
      await exec("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
    } catch {}
    try {
      await exec("launchctl", ["bootstrap", `gui/${process.getuid()}`, PLIST]);
      loaded = true;
    } catch (e) {
      err = e.stderr?.toString().trim() || e.message;
    }

    if (loaded) {
      console.log(`✓ 已安装开机自启：${PLIST}`);
      console.log(`  日志：${path.join(root, "data", "daemon.log")}`);
    } else {
      console.log(`! plist 已写入，但 launchd 加载失败：${err}`);
      console.log("");
      console.log(`  不影响使用 —— MCP 适配层会在调用工具时按需自动拉起 daemon，`);
      console.log(`  所以「开机自启」不是必需的。想要手动起：`);
      console.log(`    cd ${root} && npm start`);
      console.log(`  plist 位置：${PLIST}`);
    }
    console.log("");
    return;
  }

  if (cmd === "uninstall") {
    try {
      await exec("launchctl", ["unload", PLIST]);
    } catch {}
    await fs.rm(PLIST, { force: true });
    console.log(`✓ 已卸载开机自启`);
    console.log("");
    return;
  }

  console.error(`未知命令：${cmd}（可用 install / uninstall / status）`);
  process.exit(1);
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
