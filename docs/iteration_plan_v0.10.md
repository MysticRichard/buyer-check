# BuyerCheck 迭代记录 v0.10.0 / v0.10.1（事后整理）

> 本文根据 `CHANGELOG.md` 的 0.10.0 / 0.10.1 条目与仓库代码事后整理，**不是当时的决策原文**；只复述可核实的事实，不补写当时未记录的取舍。

## 1. 版本与范围

| 版本 | 日期 | 主题 | 交付范围 |
| --- | --- | --- | --- |
| v0.10.0 | 2026-11-16 | 通用核验与决策增强（F1–F12） | 国家能力表 0.6.0、官方入口发现、证件号本地自检、实体匹配门、8 类公开足迹探针、8 条官方来源红旗（23 → 31）、PDF 元数据、交易条款、付款画像、批量分诊、复查对比、检索日志、本地化话术、能力降级；A68–A135 |
| v0.10.1 | 2026-11-17 | 验收补齐（Z9/Z21/Z4） | `alias` 匹配键（仅 `alias_source:"official"` 计入）、768 组合条款复跑、GSTIN/PAN `source_url` 登记、判断行与卡片反绕过；A136–A140 |

两版均保持：评分公式、分档 0–29/30–59/60–100、31 条红旗编号与权重、覆盖分母 8、置信度 R1–R5 不变；精简包 28 文件；无新增必需第三方依赖。

## 2. 代码里能核实的落点

- `scripts/country_capabilities.json`：`schema_version` 为 `0.6.0`，20 个国家条目，含 `global_sources`、`rules`、`multilingual_keywords`；未核实字段为 `null`。
- `scripts/identity_check.py/.mjs`：`country`（能力表查询与入口发现）、`idcheck`（GSTIN/PAN 掩码自检，未核对国家 `no-rule`）、`match`（实体匹配门）、`registry`（挪威 Brønnøysundregistrene，NLOD 2.0，默认离线）等子命令。
- `scripts/render_card.py/.mjs`：新增 `display.verdict` 判断行（与动作阶梯/证据校验，失败回退模板并记 `invalid-display`）、`id_checks`/`doc_checks` 自检行、`footprint` 足迹行、能力行、检索行、`--batch`、`--diff`、`--report`、`scripts[].localized`。
- `scripts/red_flags.json`：31 条红旗；新增 `RF-FOOT-001`–`005`、`RF-ID-004`/`005`、`RF-DOC-001`（权重 3/3/3/2/2/2/2/1）。
- `scripts/account_check.py/.mjs`：IBAN mod-97 与 BIC 校验；付款画像映射既有 RF-PAY/RF-ACC 红旗。
- `tests/cases/`：A68–A140；`tests/eval/inquiries.jsonl` 当时 45 条。
- `submission.manifest.json`：版本 0.10.0 / 0.10.1；28 文件上限。

## 3. 未在本文补写的部分

- 当时的 issue、评审记录与负责人决策过程没有进入仓库，本文不推测。
- v0.10.0 的具体任务编号（F1–F12）只在 CHANGELOG 出现；对应实现细节以代码与 `docs/validation.md` 为准。