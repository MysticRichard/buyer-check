# C-01 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 基线：`8ab0c76`（v0.11.0）
- 任务：渠道枚举补全（P1）
- 结论：**新增 `made_in_china`、`social_media`；只作线索，不改卡片字节；A225–A226 通过。**

## 1. 改动

- `render_card.py/.mjs` 的 `CHANNEL_SET` 增加 `made_in_china`、`social_media`（不新增 `manual`，保留 `other`/`unknown`）。
- `SKILL.md` 第 0 步渠道枚举同步。
- `data-sources/global.md` 第十四节增加两行：
  - Made-in-China：会员等级/认证标识/账号注册时长，**具体字段名待核实**；平台标识只作线索，不证明身份。
  - 社交媒体私信（Instagram/TikTok/Telegram 等）：优先按头像与账号时长人工核对清单，名称 + 电话/域名双匹配。
- 渠道不参与评分、等级、置信度、覆盖分母。

## 2. 验证

- A225 `made_in_china` / `social_media` 被识别，卡片字节与不带 channel 相同。
- A226 未知值 `wechat` 回退 `unknown` 且计数 1，不崩溃。
- 全量 210/210。

## 3. 遗留

- Made-in-China 平台字段名与会员体系未在页面核对，文档已标“待核实”，不凭印象写具体字段。
- 社交媒体渠道只做人工核对清单，不做平台 API 或自动登录。