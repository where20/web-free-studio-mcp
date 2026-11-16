---
name: web-free-studio
description: 本机免费视频生成工作台（PabaTV 账号池 + Veda Studio 免账号）。当用户要生成 AI 视频、做文生视频/图生视频、查视频生成任务进度、或要批量排产视频时使用。提供 7 个 MCP 工具（wfs_status / wfs_generate / wfs_tasks / wfs_task / wfs_accounts / wfs_sync / wfs_doctor）。
---

# web-free-studio · 本机免费视频生成

两个免费上游的统一工作台，跑在本机 daemon（`:8790`）上，通过 MCP 工具调用。

| 上游 | 通道 | 额度 | 出片耗时 | 参考素材 |
|---|---|---|---|---|
| **Veda Studio** | 纯 HTTP（无需浏览器） | 20 credit/天，按**出口 IP** 计 | 5s ≈ 5–6 分钟 | ❌ 不支持 |
| **PabaTV** | 真实浏览器（TLS 指纹 + Turnstile） | 15 条/账号/天 | 10–40 分钟 | ✅ 图/视频/音频/首尾帧 |

**默认选 Veda**：更快、免账号、不依赖浏览器。只有需要参考素材或首尾帧时才用 Paba。

---

## 标准流程

```
wfs_status  →  wfs_generate  →  （等 5–40 分钟）  →  wfs_task  →  拿 assetVideo
```

1. **先看额度**：`wfs_status` 返回 Paba 各账号今日剩余、Veda 剩余 credit、在途任务数。
2. **提交**：`wfs_generate` 传 `provider`、`prompt`、`duration`、`aspect`。
3. **等**：视频生成是分钟级，不要轮询太频繁。Veda 约 5–6 分钟，Paba 10–40 分钟。
4. **取产物**：`wfs_task` 用返回的 `upstreamId` 查，拿到 `assetVideo`（本地文件路径）。

---

## 硬规则（踩过坑，别再犯）

### 1. Veda 额度按出口 IP 计
**换设备、清 cookie、伪造 device id 都无效** —— 实测验证过。额度是 24 小时滚动窗口，恢复时间看 `wfs_status` 里的 `resetsAt`。

> 用户额度用完时，**不要**建议「换个设备试试」或「用代理」。这属于规避访问控制，不做。
> 正路只有：等额度恢复 / 改用 Paba 上游 / 向作者申请 unlock key / 自部署开源版本。

### 2. Veda prompt 至少 32 字符
校验打在**用户原文**上。如果先自动补全三段式格式再校验长度，"hi" 会被补成 200+ 字符从而通过，白扣 1 credit —— 这个坑已经踩过一次。

写 prompt 时给足画面信息：主体、动作、环境、光线、镜头、风格。

### 3. Veda 强制三段式格式
上游要求 prompt 含这三段（缺 → 400，不扣额度）：
```
integrated_multimodal_description: ...
overall_soundscape: ...
non_diegetic_music: ...
```
daemon 会自动补全缺失段，**你不需要手动写**。但如果用户要精确控制音效/配乐，可以自己写全。

### 4. 只有 minimax-h3-flash 免费
Paba 侧其他模型都按秒扣积分。`model` 参数保持默认即可。

### 5. Veda 时长只能是 5 / 10 / 15
成本 1 / 2 / 3 credit。10s 和 15s 出片更慢、额度消耗翻倍，**除非用户明确要求，否则用 5s**。

### 6. Paba 必须走真实浏览器
纯 curl / fetch 会被 403（challenge_required）。沙箱内 spawn Chrome 可能失败（CDP 已断开），此时用「导入 Cookie」方式接入。

### 7. 单实例
本地库是单文件，多个 daemon 会互相覆盖。端口被占说明已有实例在跑，先停旧的。

---

## 参考素材（仅 Paba）

`wfs_generate` 的 `mode` 决定素材字段：

| mode | 需要 | 上限 |
|---|---|---|
| `text` | 只要 prompt | — |
| `reference` | `referenceImages` / `referenceVideos` / `referenceAudios` | 9 图 / 3 视频 / 3 音频 |
| `first` | `firstFrame` | 1 |
| `frames` | `firstFrame` + `lastFrame` | 2 |

**素材可以传本地文件路径**（适配层自动读文件转 data URL），也可以直接传 data URL。单文件 ≤20MB，合计 ≤24MB。

传素材时 `mode` 必须对应，否则 daemon 会拒绝：
- `mode=text` 传了素材 → 报错
- `mode=reference` 没传素材 → 报错

---

## 错误码对照

| code | 含义 | 下一步 |
|---|---|---|
| `daemon_offline` | daemon 没跑 | `cd <web-free-studio> && npm start` |
| `quota_exhausted` | Veda credit 不足 | 等额度恢复，或改用 paba |
| `quota_network` | 同网络当天超 30 条 | 等明天 |
| `too_many_pending` | 在途超上限 | 等出片再提交 |
| `validation` | 参数不合法 | 按提示改 |
| `challenge_required` | 账号需人机验证 | `wfs_accounts {action:"challenge"}` |
| `chrome_unavailable` | Chrome 起不来 | 改用导入 Cookie 接入账号 |
| `login_failed` | 账号不可用 | `wfs_accounts {action:"login"}` 重新授权 |

---

## 账号管理

```
wfs_accounts { action: "list" }                      # 看全部账号与额度
wfs_accounts { action: "sync", accountId: "xxx" }    # 同步单个账号
wfs_accounts { action: "toggle", accountId, disabled }# 停用/启用
wfs_accounts { action: "challenge", accountId }      # 触发人机验证
wfs_accounts { action: "login", accountId }          # 打开登录页等人工授权
wfs_accounts { action: "cookies", accountId, cookies }# 导入 cookie（换机迁移用）
wfs_accounts { action: "delete", accountId, purge }  # 删除账号
```

---

## 排产建议

- **一条任务不要提交两次**：daemon 有 60 秒同参数幂等去重，但超过窗口就会重复提交、重复扣额度。
- **批量任务错开提交**：全局并发 2，单账号在途上限 2。Veda 在途上限 4（上游 2 个 GPU 槽位）。
- **Paba 账号会自动选**：提交时挑「消耗最少 + 在途最少」的账号，不用手动指定。
- **产物会落到本地**：`data/assets/<日期>/`，视频 + 缩略图 + meta json。

---

## 换电脑

1. `node scripts/install.mjs` —— 写各 agent 的 MCP 配置
2. `node scripts/daemon.mjs install` —— 装开机自启
3. `node scripts/doctor.mjs` —— 自检

**会迁移的**：代码、MCP 配置、产物 assets、任务账本。
**不会迁移的**：
- Veda 额度（按出口 IP 计，新电脑是新额度）
- Paba 账号 cookie（手动：`data/accounts/*.cookies.json` 复制过去，或重新登录）
- Chrome profile（不复制，重新授权更干净）

---

## 边界

**不做**代理池轮换、出口 IP 切换、设备指纹伪造 —— 技术上可行但属于规避上游访问控制，本项目只在上游给的额度内排队使用。
