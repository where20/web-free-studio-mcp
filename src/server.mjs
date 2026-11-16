/**
 * web-free-studio MCP server
 *
 * 把本机 web-free-studio daemon（:8790）的能力暴露成标准 MCP 工具，
 * 让 WorkBuddy / Codex / Claude Code / Cursor 等任何 MCP 客户端都能用。
 *
 * 设计原则：
 *  1. 薄壳 —— 业务规则全在 daemon，这里只做参数整形与结果压缩
 *  2. 可诊断 —— daemon 离线、额度不足、prompt 太短等错误都返回可执行的中文提示
 *  3. 不越界 —— 只暴露「免费模型」通道，不做任何额度/设备规避
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { get, post, del, isAlive, ensureDaemon, baseUrl } from "./daemon.mjs";
import { toDataUrls, toDataUrl, REF_HINT } from "./refs.mjs";

const SERVER_NAME = "web-free-studio";
const SERVER_VERSION = "0.1.0";

/* ------------------------------------------------------------------ *
 * 输出整形
 * ------------------------------------------------------------------ */

function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

/** 把上游 task 行压成 agent 真正关心的字段 */
function slimTask(t) {
  if (!t) return null;
  const out = {
    upstreamId: t.upstreamId,
    provider: t.provider || "paba",
    status: t.status,
    prompt: (t.prompt || "").slice(0, 160),
    duration: t.duration,
    aspectRatio: t.aspectRatio,
    model: t.model,
  };
  if (t.accountId) out.accountId = t.accountId;
  if (t.queuePosition != null) out.queuePosition = t.queuePosition;
  if (t.queueEtaSeconds != null) out.queueEtaSeconds = t.queueEtaSeconds;
  if (t.error) out.error = t.error;
  if (t.asset?.video) out.assetVideo = t.asset.video;
  if (t.asset?.thumb) out.assetThumb = t.asset.thumb;
  if (t.video?.cdn_url) out.cdnUrl = t.video.cdn_url;
  if (t.asset?.bytes) out.bytes = t.asset.bytes;
  if (t.createdAt) out.createdAt = t.createdAt;
  if (t.finishedAt) out.finishedAt = t.finishedAt;
  return out;
}

/** 统一的错误出口：把 daemon 的 code 翻译成「下一步该做什么」 */
function fail(e) {
  const code = e?.code || "error";
  const msg = e?.message || String(e);

  const advice = {
    daemon_offline: `先启动 daemon：cd <web-free-studio> && npm start（默认 ${baseUrl()}）`,
    quota_exhausted: "等额度恢复（Veda 是 24 小时滚动窗口）后重试，或改用 paba 上游",
    quota_network: "同网络当天提交数已达上限，等明天或换上游",
    too_many_pending: "已有在途任务，等出片再提交",
    validation: "按提示修正参数后重试",
    challenge_required: "该账号需人机验证，先用 wfs_accounts 里的 challenge 流程处理",
    login_failed: "账号不可用，用 wfs_accounts 重新授权",
    chrome_unavailable: "本机 Chrome 起不来，改用「导入 Cookie」方式接入账号",
    upstream_error: "上游返回异常，可重试一次；持续失败就查 daemon 日志",
  }[code];

  const payload = { error: msg, code };
  if (advice) payload.next = advice;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** 包一层，把任何异常转成结构化错误 */
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

/**
 * 需要 daemon 的操作统一走这里：daemon 不在就自动拉起。
 * 这台机器的 launchctl/crontab 都被沙箱禁用，做不了开机自启，
 * 所以把「起 daemon」这件事交给适配层按需触发。
 */
async function withDaemon(fn) {
  const started = await ensureDaemon();
  return fn(started);
}

/* ------------------------------------------------------------------ *
 * 工具实现
 * ------------------------------------------------------------------ */

async function toolStatus() {
  return withDaemon(async (started) => {
    const [state, veda] = await Promise.all([
      get("/api/state").catch(() => null),
      get("/api/veda/state").catch(() => null),
    ]);

    const out = {
      daemon: { url: baseUrl(), alive: true, autoStarted: Boolean(started?.started) },
      paba: state
        ? {
            accounts: (state.accounts || []).map((a) => ({
              id: a.id,
              label: a.label,
              status: a.status,
              backend: a.backend,
              disabled: a.disabled,
              consumedToday: a.usage?.consumed,
              limit: a.usage?.limit,
              left: a.usage?.left,
              active: a.active,
              needsChallenge: a.needsChallenge,
              lastError: a.lastError,
            })),
            queue: state.queue,
            models: (state.models || []).map((m) => ({ id: m.id, label: m.label, note: m.note })),
            limits: state.limits,
          }
        : { error: "读取 Paba 状态失败" },
      veda: veda
        ? {
            ok: veda.ok,
            quota: veda.quota
              ? {
                  used: veda.quota.used,
                  limit: veda.quota.limit,
                  remaining: veda.quota.remaining,
                  resetsAt: veda.quota.resetsAt,
                  costs: veda.quota.costs,
                }
              : null,
            error: veda.error,
            local: veda.local ?? null,
            health: veda.health ?? null,
            backendOnline: veda.config?.backendOnline,
            gpu: veda.config?.gpu,
            numGpus: veda.config?.numGpus,
          }
        : { error: "读取 Veda 状态失败" },
    };
    return text(out);
  });
}

async function toolGenerate(args) {
  return withDaemon(async () => {
    const provider = args.provider || "veda";
    if (provider === "veda") {
      const body = {
        prompt: args.prompt,
        duration: args.duration ?? 5,
        aspect: args.aspect || "16:9",
      };
      if (args.seed != null) body.seed = args.seed;
      const out = await post("/api/veda/generate", body);
      return text({
        provider: "veda",
        upstreamId: out.upstreamId,
        deduped: out.deduped,
        status: out.task?.status,
        quota: out.quota
          ? { used: out.quota.used, limit: out.quota.limit, remaining: out.quota.remaining, resetsAt: out.quota.resets_at }
          : null,
        note: out.deduped
          ? "同参数刚提交过，复用了已有任务"
          : "已提交。Veda 实测 5s/9:16 约需 5–6 分钟出片，请用 wfs_task 轮询",
      });
    }

    // paba 通道
    const body = {
      prompt: args.prompt,
      model: args.model || "minimax-h3-flash",
      mode: args.mode || "text",
      duration: args.duration ?? 5,
      resolution: args.resolution || "768p",
      aspectRatio: args.aspectRatio || "16:9",
      async: true,
    };
    if (args.accountId) body.accountId = args.accountId;
    if (args.seed != null) body.seed = args.seed;

    if (args.mode === "reference") {
      body.referenceImages = await toDataUrls(args.referenceImages || []);
      body.referenceVideos = (await toDataUrls(args.referenceVideos || [])).map((data) => ({ data, withAudio: false }));
      body.referenceAudios = await toDataUrls(args.referenceAudios || []);
    } else if (args.mode === "first") {
      body.firstFrame = await toDataUrl(args.firstFrame);
    } else if (args.mode === "frames") {
      body.firstFrame = await toDataUrl(args.firstFrame);
      body.lastFrame = await toDataUrl(args.lastFrame);
    }

    const out = await post("/api/generate", body);
    return text({
      provider: "paba",
      jobId: out.jobId,
      accountId: out.accountId,
      status: out.status,
      deduped: out.deduped,
      note: "已入队。Paba 免费档实测需 10–40 分钟出片，用 wfs_task 查进度",
    });
  });
}

async function toolTasks(args) {
  return withDaemon(async () => {
    const q = new URLSearchParams();
    if (args.provider) q.set("provider", args.provider);
    if (args.accountId) q.set("accountId", args.accountId);
    const out = await get(`/api/tasks?${q.toString()}`);
    const tasks = (out.tasks || []).map(slimTask);
    return text({
      count: tasks.length,
      tasks,
      hint: "Paba 任务用 upstreamId 查；Veda 任务用 upstreamId 查（本地上游无列表接口，只能靠本地账本）",
    });
  });
}

async function toolTask(args) {
  return withDaemon(async () => {
    const id = String(args.upstreamId || "").trim();
    if (!id) throw new Error("upstreamId 不能为空");

    // 先按上游任务查（本地账本），命中即返回
    const out = await get(`/api/tasks`);
    const hit = (out.tasks || []).find((t) => t.upstreamId === id);
    if (hit) {
      const s = slimTask(hit);
      s.videoUrl = hit.asset?.video ? assetUrl(hit.asset.video) : null;
      return text(s);
    }

    // 本地没有就尝试同步一次（Veda 前进式：主动拉一次上游）
    await post("/api/veda/sync", {}).catch(() => {});
    await post("/api/sync", {}).catch(() => {});
    const again = await get(`/api/tasks`);
    const hit2 = (again.tasks || []).find((t) => t.upstreamId === id);
    if (hit2) {
      const s = slimTask(hit2);
      s.videoUrl = hit2.asset?.video ? assetUrl(hit2.asset.video) : null;
      return text(s);
    }

    return text({
      upstreamId: id,
      found: false,
      note: "本地账本没有这个任务。Veda 上游无列表接口，历史任务无法回溯；Paba 可在 daemon 里核对账号同步结果",
    });
  });
}

/** 把 daemon 的绝对资产路径转成可访问的 HTTP 路径 */
function assetUrl(absPath) {
  const m = String(absPath).match(/\/data\/assets\/(.+)$/);
  return m ? `${baseUrl()}/assets/${m[1]}` : null;
}

async function toolAccounts(args) {
  return withDaemon(async () => {
    const action = args.action || "list";
    const id = args.accountId;

    if (action === "list") {
      const state = await get("/api/state");
      return text({
        accounts: (state.accounts || []).map((a) => ({
          id: a.id,
          label: a.label,
          status: a.status,
          backend: a.backend,
          disabled: a.disabled,
          consumedToday: a.usage?.consumed,
          limit: a.usage?.limit,
          left: a.usage?.left,
          active: a.active,
          needsChallenge: a.needsChallenge,
          lastError: a.lastError,
        })),
      });
    }

    if (!id) throw new Error(`${action} 操作需要 accountId`);

    if (action === "sync") {
      const out = await post("/api/sync", { accountId: id });
      return text(out);
    }
    if (action === "toggle") {
      const out = await post(`/api/accounts/${id}/toggle`, { disabled: Boolean(args.disabled) });
      return text(out);
    }
    if (action === "challenge") {
      const out = await post(`/api/accounts/${id}/challenge`, {});
      return text(out);
    }
    if (action === "delete") {
      const out = await post(`/api/accounts/${id}/delete`, { purge: Boolean(args.purge) });
      return text(out);
    }
    if (action === "detail") {
      const out = await get(`/api/accounts/${id}/detail`);
      return text(out);
    }
    if (action === "login") {
      const out = await post(`/api/accounts/${id}/login`, {});
      return text(out);
    }
    if (action === "cookies") {
      if (!args.cookies) throw new Error("cookies 操作需要 cookies 数组");
      const out = await post(`/api/accounts/${id}/cookies`, { cookies: args.cookies });
      return text(out);
    }
    throw new Error(`未知 action：${action}`);
  });
}

async function toolSync() {
  return withDaemon(async () => {
    const [paba, veda] = await Promise.all([
      post("/api/sync", {}).catch((e) => ({ error: e.message })),
      post("/api/veda/sync", {}).catch((e) => ({ error: e.message })),
    ]);
    return text({ paba, veda });
  });
}

async function toolDoctor() {
  return withDaemon(async (started) => {
    const [state, veda] = await Promise.all([
      get("/api/state").catch(() => null),
      get("/api/veda/state").catch(() => null),
    ]);
    const out = {
      daemon: { url: baseUrl(), alive: true, autoStarted: Boolean(started?.started) },
      node: process.version,
      paba: state
        ? {
            accounts: state.accounts?.length ?? 0,
            online: (state.accounts || []).filter((a) => a.status === "online" && !a.disabled).length,
            models: state.models?.length ?? 0,
          }
        : { error: "读取失败" },
      veda: {
        ok: veda?.ok ?? false,
        remaining: veda?.quota?.remaining ?? null,
        limit: veda?.quota?.limit ?? null,
        resetsAt: veda?.quota?.resetsAt ?? null,
        error: veda?.error ?? null,
      },
    };
    out.hints = [
      "Node 需要 >= 22",
      "Paba 通道需要本机 Chrome；沙箱内 spawn Chrome 可能失败，可用「导入 Cookie」方式接入",
      "Veda 通道是纯 HTTP，不依赖浏览器，但额度按出口 IP 计，换设备无效",
      "daemon 由 MCP 适配层按需自动拉起（launchctl/crontab 在受限环境不可用）",
    ];
    return text(out);
  });
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "web-free-studio：本机免费视频生成工作台（PabaTV 账号池 + Veda Studio 免账号）。" +
        "典型流程：wfs_status 看额度 → wfs_generate 提交 → wfs_task 轮询出片。" +
        "重要：Veda 额度按出口 IP 计且 24 小时滚动恢复；Paba 免费档单账号每天 15 条；" +
        "只有 minimax-h3-flash 是免费模型，不要选付费模型。",
    },
  );

  server.registerTool(
    "wfs_status",
    {
      title: "查看服务状态与额度",
      description:
        "读取本机 daemon 的账号池、各账号今日额度、在途任务、队列状态、Veda 剩余 credit。提交任务前先调这个。",
      inputSchema: {},
    },
    async () => guard(toolStatus),
  );

  server.registerTool(
    "wfs_generate",
    {
      title: "提交视频生成任务",
      description:
        "提交一条视频生成任务。provider=veda 走纯 HTTP（快、免账号，5/10/15s）；provider=paba 走账号池浏览器通道" +
        "（支持参考图/首尾帧，但耗时 10–40 分钟）。注意 Veda prompt 至少 32 字符。",
      inputSchema: {
        provider: z.enum(["veda", "paba"]).default("veda").describe("上游通道，默认 veda"),
        prompt: z.string().min(1).describe("画面描述。Veda 要求至少 32 字符；只写画面，不要写镜头术语之外的东西"),
        duration: z.number().int().min(4).max(15).default(5).describe("时长秒数。Veda 只接受 5/10/15；Paba 4–15"),
        aspect: z.string().default("16:9").describe("画幅，Veda 用：16:9 / 9:16 / 4:3 / 1:1"),
        aspectRatio: z.string().optional().describe("画幅，Paba 用：16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9"),
        seed: z.number().int().optional().describe("随机种子，给定则结果可复现"),
        model: z.string().default("minimax-h3-flash").describe("模型 id。只有 minimax-h3-flash 是免费档"),
        mode: z
          .enum(["text", "reference", "first", "frames"])
          .default("text")
          .describe("Paba 模式：text 文生 / reference 全能参考 / first 图生 / frames 首尾帧"),
        accountId: z.string().optional().describe("Paba 指定账号；不填则自动挑额度最少且在途最少的账号"),
        referenceImages: z.array(z.string()).optional().describe(`Paba 参考图路径或 data URL，最多 9 张。${REF_HINT}`),
        referenceVideos: z.array(z.string()).optional().describe("Paba 参考视频路径或 data URL，最多 3 个"),
        referenceAudios: z.array(z.string()).optional().describe("Paba 参考音频路径或 data URL，最多 3 个"),
        firstFrame: z.string().optional().describe("Paba 首帧图路径或 data URL"),
        lastFrame: z.string().optional().describe("Paba 尾帧图路径或 data URL"),
      },
    },
    async (args) => guard(() => toolGenerate(args)),
  );

  server.registerTool(
    "wfs_tasks",
    {
      title: "列出任务",
      description: "按 provider / accountId 过滤任务列表，返回精简后的状态、排队位、产物路径。",
      inputSchema: {
        provider: z.enum(["paba", "veda"]).optional(),
        accountId: z.string().optional(),
      },
    },
    async (args) => guard(() => toolTasks(args)),
  );

  server.registerTool(
    "wfs_task",
    {
      title: "查单个任务",
      description:
        "按 upstreamId 查单个任务的最新状态与产物路径。本地查不到时会主动同步一次上游再查。" +
        "Veda 上游无列表接口，历史任务无法回溯。",
      inputSchema: {
        upstreamId: z.string().describe("上游任务 id（Paba 是 h3_xxx，Veda 是 job uuid）"),
      },
    },
    async (args) => guard(() => toolTask(args)),
  );

  server.registerTool(
    "wfs_accounts",
    {
      title: "账号池管理",
      description:
        "查看或操作 Paba 账号池：list 列表 / sync 同步某个账号 / toggle 停用启用 / challenge 触发人机验证 / detail 详情 / delete 删除。",
      inputSchema: {
      action: z
        .enum(["list", "sync", "toggle", "challenge", "detail", "delete", "login", "cookies"])
        .default("list"),
        accountId: z.string().optional().describe("除 list 外的操作都需要"),
        disabled: z.boolean().optional().describe("toggle 用：true 停用 / false 启用"),
        purge: z.boolean().optional().describe("delete 用：true 连浏览器 profile 一起删"),
        cookies: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              domain: z.string().optional(),
              path: z.string().optional(),
            }),
          )
          .optional()
          .describe("cookies 用：从浏览器导出的会话 cookie 数组（换机迁移账号用）"),
      },
    },
    async (args) => guard(() => toolAccounts(args)),
  );

  server.registerTool(
    "wfs_sync",
    {
      title: "主动同步",
      description: "同时触发 Paba 全账号同步与 Veda 任务同步，把上游最新状态拉回本地。",
      inputSchema: {},
    },
    async () => guard(toolSync),
  );

  server.registerTool(
    "wfs_doctor",
    {
      title: "自检",
      description:
        "检查 daemon 是否在线、Node 版本、账号数、Veda 额度读数。换电脑后第一步就跑这个。",
      inputSchema: {},
    },
    async () => guard(toolDoctor),
  );

  return server;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

// 直接执行时起 stdio server
if (import.meta.url === `file://${process.argv[1]}`) {
  startStdio().catch((e) => {
    process.stderr.write(`[wfs-mcp] 启动失败：${e?.stack || e}\n`);
    process.exit(1);
  });
}
