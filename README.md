# web-free-studio-mcp

把本机 [web-free-studio](../README.md) 视频生成工作台暴露成 **标准 MCP 工具**，
让 WorkBuddy / Codex / Claude Code / Cursor 等任何 MCP 客户端都能用。

```
MCP 客户端  →  wfs-mcp (stdio)  →  daemon :8790  →  PabaTV / Veda Studio
```

## 安装

```bash
# 1. 写各 agent 的 MCP 配置（自动检测已安装的客户端）
npx -y github:where20/web-free-studio-mcp install

# 2. 自检
npx -y github:where20/web-free-studio-mcp doctor
```

> WorkBuddy 用户：写完配置后需在**连接器管理页右上角点「信任」**才会生效。

**daemon 不需要手动启动** —— MCP 适配层会在第一次调用工具时自动把它拉起来
（这台机器的 `launchctl bootstrap` / `crontab` 都被沙箱禁用，做不了开机自启）。
想手动起也可以：`cd <web-free-studio> && npm start`。
可选装开机自启：`npx -y github:where20/web-free-studio-mcp daemon install`（受限环境会失败但不影响使用）。

## 工具

| 工具 | 作用 |
|---|---|
| `wfs_status` | 账号池、各账号今日额度、在途任务、Veda 剩余 credit |
| `wfs_generate` | 提交视频生成任务（provider = veda / paba） |
| `wfs_tasks` | 列出任务（可按 provider / accountId 过滤） |
| `wfs_task` | 查单个任务状态与产物路径 |
| `wfs_accounts` | 账号池管理（列表/同步/停用/验证/授权/导入 cookie/删除） |
| `wfs_sync` | 主动同步上游状态 |
| `wfs_doctor` | 环境自检（换机第一步） |

## 命令

| 命令 | 作用 |
|---|---|
| `wfs-mcp` | 起 MCP server（stdio），客户端会自动调用 |
| `wfs-mcp install` | 写各 agent 的 MCP 配置 |
| `wfs-mcp daemon install\|uninstall\|status` | daemon 开机自启 |
| `wfs-mcp doctor` | 自检 |
| `wfs-mcp selftest` | MCP 协议层自测 |

## 手动配置

不想用安装脚本的话，直接写配置：

```jsonc
// ~/.workbuddy/mcp.json
{
  "mcpServers": {
    "web-free-studio": {
      "command": "npx",
      "args": ["-y", "github:where20/web-free-studio-mcp"]
    }
  }
}
```

```toml
# ~/.codex/config.toml
[mcp_servers.web-free-studio]
command = "npx"
args = ["-y", "github:where20/web-free-studio-mcp"]
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WFS_HOST` | `127.0.0.1` | daemon 主机 |
| `WFS_PORT` | `8790` | daemon 端口 |
| `WFS_ROOT` | 自动探测 | web-free-studio 目录（daemon 自启用） |

## 离线 / 内网用法

不依赖 GitHub 时，用本地 stdio 模式：

```bash
cd /path/to/web-free-studio/mcp && npm install
node scripts/install.mjs --stdio
```

## 设计说明

MCP 层是**薄壳**：只做参数整形（本地路径 → data URL）和结果压缩，
所有业务规则（额度闸、prompt 规范化、队列、产物镜像）都在 daemon 里，
避免两份实现漂移。
