# N-08 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：使用指南与首次上手引导（P0）
- 结论：**A171–A178 通过；短版 6 行、完整版 29 行；三处文本一致；不代替独立审核。**

## 1. 做了什么

- `render_card.py/.mjs --guide short|full [--lang zh|en]`：固定文本、不读证据包、不联网、不写盘、不读系统时间；Python 用 UTF-8 字节输出，Node 同步。
- 短版（zh/en）非空行 6 行；完整版（zh/en）非空行 29 行，含五个小节与四档信息表。
- `card_template.md` 新增“七、使用指南”，文本与脚本常量逐字一致。
- `README.md` 新增“30 秒上手”（三步 + 3 个示例 + 一句求助提示）；3 个示例与指南 1–3 号逐字相同。
- `SKILL.md` 新增“0.0 求助与空输入”：中英求助词、可用线索定义、空输入不连环追问、指南原样输出；frontmatter `description` 追加使用提示（总长 441 字符 ≤1024）。
- 示例全部虚构：`.example` 域名、`+44 7700 900123`（Ofcom 影视保留段）、`GB82 WEST 1234 5698 7654 32`（既有公开测试样例）。

## 2. 改动文件

- `scripts/render_card.py`、`scripts/render_card.mjs`
- `card_template.md`、`README.md`、`SKILL.md`
- `tests/run_cases.mjs`（`guide`、`guide_examples`、`skill_guide` runner）
- `tests/cases/A171`–`A178`
- `tests/consistency.mjs`（指南块与 README 示例一致性）

## 3. 验证

- A171 短版 ≤12 行、≥2 示例、含“使用指南/guide”。
- A172 完整版 ≤40 行、五个小节标题与四档表。
- A173 示例电话 `phone_check` 解析为 GB；IBAN `account_check` 的 mod-97 通过；域名全部 `.example`。
- A174 指南无禁用词/技术词；仓库 privacy clean。
- A175 Python/Node 逐字节一致（zh/en × short/full）。
- A176 模板与 README 示例一致；A177 SKILL 求助词与 description；A178 不读证据包、旧包字节不变。
- 全量仓库 178/178；包内 172 passed / 0 failed / 6 skipped。

## 4. 人工走查记录（6 个“小白输入”）

本次未在真实客户端会话中逐个执行（当前工作区只有脚本与文档，没有可调用的 Skill 客户端入口），以下记录的是**按 `SKILL.md` 0.0 规则推导的期望路径**，需要在独立审核/真实客户端阶段补实测：

| 输入 | 期望路径 | 依据 |
| --- | --- | --- |
| `背调` | 无可用线索 → `--guide short` → 短版提示，不追问 | 0.0 空输入规则 |
| `帮我查一下这个客户` | 同上 | 0.0 空输入规则 |
| `怎么用` | 命中中文求助词 → `--guide full` | 0.0 求助词表 |
| `Anna，+44 7700 900123` | 有名称 + 带 + 区号电话 → 直接开始查，不出指南 | 可用线索定义 |
| `info@nordic-import.example` | 有邮箱 → 直接开始查 | 可用线索定义 |
| `help` | 命中英文求助词 → `--guide full --lang en` | 0.0 求助词表 |

## 5. 遗留

- 未在真实客户端执行上述 6 条走查；审核阶段需补记录。
- 指南只能被动出现，无法在安装时主动推送；用户既不看 README 也不说求助词时仍可能不知道如何开始。