/**
 * 参考素材处理：把「本地文件路径」转成 daemon 认识的 data URL。
 *
 * daemon 侧的 buildVideoPayload 只认 /^data:[a-z0-9.+/-]+;base64,/i
 * （见 server/src/api.mjs 的 isDataUrl），所以本地路径必须在这里转换。
 *
 * 为什么不直接把路径丢给 daemon：daemon 是纯 HTTP 服务，不该知道调用方的文件系统布局；
 * 而 agent 手上拿到的通常就是路径。让适配层做这层翻译最合适。
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

const DATA_URL = /^data:[a-z0-9.+/-]+;base64,/i;

/** 单个素材上限（daemon 侧总限 24MB，这里先卡一道更细的） */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

/** 展开 ~ 与相对路径 */
export function resolvePath(p) {
  let s = String(p || "").trim();
  if (!s) return s;
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

/**
 * 把一个素材输入转成 data URL。
 * 输入可以是：data URL（透传）/ 本地绝对或相对路径（读文件编码）。
 */
export async function toDataUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (DATA_URL.test(raw)) return raw;

  const file = resolvePath(raw);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new Error(`参考素材读不到：${raw}（解析为 ${file}）`);
  }
  if (!stat.isFile()) throw new Error(`参考素材不是文件：${file}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `参考素材太大：${file}（${(stat.size / 1024 / 1024).toFixed(1)}MB，单文件上限 ${MAX_FILE_BYTES / 1024 / 1024}MB）`,
    );
  }
  const buf = await fs.readFile(file);
  return `data:${mimeOf(file)};base64,${buf.toString("base64")}`;
}

/** 批量转换；保持与输入一一对应（失败即抛，不静默丢素材） */
export async function toDataUrls(list) {
  if (!list?.length) return [];
  const out = [];
  for (const item of list) out.push(await toDataUrl(item));
  return out;
}

/**
 * 给 agent 看的简短说明，避免它误以为可以直接传路径给上游。
 */
export const REF_HINT =
  "参考素材可传本地文件路径（自动读文件转 data URL）或直接传 data URL；" +
  `单文件 ≤${MAX_FILE_BYTES / 1024 / 1024}MB，参考图/视频/音频合计 ≤24MB。`;
