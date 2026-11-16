/**
 * daemon HTTP 客户端。
 *
 * 这一层刻意做得很薄：只负责「把一次调用变成一次 HTTP 请求」。
 * 所有业务规则（额度闸、prompt 规范化、队列、镜像）都在 daemon 里，
 * MCP 侧不复制任何判断逻辑 —— 否则两份实现迟早会漂移。
 */

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

/** daemon 的运行时基本信息，用于工具返回里交代上下文 */
export async function runtimeInfo() {
  return {
    baseUrl: baseUrl(),
    alive: await isAlive(),
  };
}
