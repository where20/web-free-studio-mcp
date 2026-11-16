/**
 * daemon HTTP 客户端。
 *
 * 这一层刻意做得很薄：只负责「把一次调用变成一次 HTTP 请求」。
 * 所有业务规则（额度闸、prompt 规范化、队列、镜像）都在 daemon 里，
 * MCP 侧不复制任何判断逻辑 —— 否则两份实现迟早会漂移。
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = Number(process.env.WFS_PORT || 8790);
const DEFAULT_HOST = process.env.WFS_HOST || "127.0.0.1";

export function baseUrl() {
  const port = Number(process.env.WFS_PORT || DEFAULT_PORT);
  const host = process.env.WFS_HOST || DEFAULT_HOST;
  return `http://${host}:${port}`;
}

/** daemon 未启动时的可执行提示 —— agent 拿到这段就知道该做什么 */
export class DaemonOfflineError extends Error {
  constructor(message) {
    super(message);
    this.name = "DaemonOfflineError";
    this.code = "daemon_offline";
  }
}

async function request(path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const url = `${baseUrl()}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { error: text.slice(0, 500) };
    }
    if (!res.ok) {
      const err = new Error(payload?.error || `daemon 返回 ${res.status}`);
      err.code = payload?.code || `http_${res.status}`;
      err.status = res.status;
      throw err;
    }
    return payload;
  } catch (e) {
    if (e instanceof DaemonOfflineError) throw e;
    if (e.name === "AbortError") {
      throw Object.assign(new Error(`请求 daemon 超时（${timeoutMs}ms）`), { code: "timeout" });
    }
    // ECONNREFUSED / fetch failed —— daemon 没跑
    throw new DaemonOfflineError(
      `连不上本机 daemon（${baseUrl()}）：${e.message}。` +
        `请先启动：cd <web-free-studio 目录> && npm start`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const get = (path, opts) => request(path, { ...opts, method: "GET" });
export const post = (path, body, opts) => request(path, { ...opts, method: "POST", body });
export const del = (path, opts) => request(path, { ...opts, method: "DELETE" });

/** daemon 是否在线（不抛错，只回布尔） */
export async function isAlive() {
  try {
    await get("/api/queue", { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保 daemon 在跑；不在就把它拉起来。
 *
 * 为什么要自动拉起：这台机器的 launchctl bootstrap / crontab 都被沙箱禁用，
 * 没法做开机自启。但 MCP 客户端本身就会拉起我们的进程 —— 与其让用户手动
 * 开终端敲 npm start，不如在这里按需启动。
 *
 * 幂等：先探测端口，被别的实例占了就直接用，不重复起。
 */
export async function ensureDaemon({ autoStart = true } = {}) {
  if (await isAlive()) return { started: false, reason: "already_running" };

  if (!autoStart) return { started: false, reason: "offline" };

  const root = await findStudioRoot();
  if (!root) {
    throw new DaemonOfflineError(
      `连不上本机 daemon（${baseUrl()}），且找不到 web-free-studio 目录来自动启动。` +
        `请设 WFS_ROOT 环境变量指向项目目录，或手动执行：cd <web-free-studio> && npm start`,
    );
  }

  const cli = path.join(root, "server", "cli.mjs");
  try {
    await fs.access(cli);
  } catch {
    throw new DaemonOfflineError(
      `找到目录 ${root} 但没有 server/cli.mjs，无法自动启动。请手动执行：cd ${root} && npm start`,
    );
  }

  // 后台拉起，脱离当前进程的生命周期
  const child = spawn(process.execPath, [cli, "serve"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // 等它起来（最多 15 秒）
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isAlive()) return { started: true, pid: child.pid, root };
  }
  throw new DaemonOfflineError(
    `自动启动 daemon 超时（15s）。请手动执行：cd ${root} && npm start，然后看 ${path.join(root, "data", "daemon.err.log")}`,
  );
}

/** 找 web-free-studio 根目录（含 server/cli.mjs 的那个） */
async function findStudioRoot() {
  const cands = [
    process.env.WFS_ROOT,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    path.join(os.homedir(), "Desktop", "REA", "web-free-studio"),
    path.join(os.homedir(), "projects", "web-free-studio"),
    path.join(os.homedir(), "web-free-studio"),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      await fs.access(path.join(c, "server", "cli.mjs"));
      return c;
    } catch {}
  }
  return null;
}

/** daemon 的运行时基本信息，用于工具返回里交代上下文 */
export async function runtimeInfo() {
  return {
    baseUrl: baseUrl(),
    alive: await isAlive(),
  };
}
