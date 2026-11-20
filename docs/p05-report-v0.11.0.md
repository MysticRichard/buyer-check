# N-05 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：制裁名单扩展 EU/UN/UK（P1）
- 结论：**实测后只有 OFAC 可配置；EU/UN/UK 如实标 `not_configured`；A163–A164 通过。**

## 1. 做了什么

逐个打开官方发布页并实测（2026-11-20）：

| 源 | 实测 | 结论 |
| --- | --- | --- |
| OFAC SDN | SLS CSV 200，免登录、无令牌、约 5.8 MB / 19k 行 | configured |
| EU Consolidated | `webgate.ec.europa.eu` 下载端点 **403**（带常见 UA 仍 403） | `not_configured`（`http-403-token-required`） |
| UN Security Council | 综合名单页面可访问（XML/HTML/PDF，页面注明 2026-11-16 更新）；旧 XML 直链 `scsanctions.un.org/resources/xml/en/consolidated.xml` **404** | `not_configured`（`xml-link-404`） |
| UK OFSI Consolidated | 页面 200，但明确标注 **OFSI Consolidated List 已于 2026-01-28 关闭**，UK Sanctions List 成为唯一来源 | `not_configured`（`ofsi-list-closed-2026-01-28`） |

- `sanctions_check.py/.mjs` 新增 `SOURCES` 与 `source_status()`；输出 `sources[]` 与 `lists_not_configured[]`。
- 未配置源不抛异常；已配置源沿用原有下载纪律（20 秒超时、内容校验、保留旧缓存、全部失败不崩溃）。
- 同名一律 `requires_manual_review: true`，不自动计分。
- 实测记录写入 `docs/validation.md` 5.1。

## 2. 改动文件

- `scripts/sanctions_check.py`、`scripts/sanctions_check.mjs`
- `docs/validation.md`
- `tests/run_cases.mjs`（`sanctions_sources` runner）
- `tests/cases/A163`、`A164`

## 3. 验证

- A163：OFAC 命中 1、未命中 0；EU/UN/UK 均在 `lists_not_configured`；Python/Node `sanctions_check` 输出一致（`consistency_scripts` 通过）。
- A164：内容非法 → `invalid-content`，旧缓存 `OLD-CACHE-BYTES` 不变；下载失败与全部地址失败由 A42–A44 覆盖，行为一致。
- 全量仓库 178/178；包内 A163/A164 只跑 Python（Node 脚本不进包），通过。

## 4. 遗留

- EU 需要访问令牌/浏览器会话；UN 未找到免令牌稳定直链；UK OFSI 已关闭。三者均不硬配置。
- 卡片“已查”表述随配置源变化仍由模型按 `sources[]` 写入；本轮未新增卡片行，避免破坏旧包字节。
- 未配置源不等于“没风险”；卡片与报告必须如实写“已查哪些”。