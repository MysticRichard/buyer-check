# N-04 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：评测补洞与指标（P0，先做）
- 结论：**A161–A162 与评测扩语料通过；`--self` 自检通过；不代替独立审核。**

## 1. 做了什么

### N-04a 红旗用例补洞

开工前对 31 条红旗逐条 grep `tests/cases/`、`tests/fixtures/` 与 `tests/eval/inquiries.jsonl`：

- 评测语料零覆盖 11 条：`RF-SAN-001`、`RF-NEG-001`、`RF-CORP-006`、`RF-FOOT-001`–`005`、`RF-ID-004`、`RF-ID-005`、`RF-DOC-001`。
- 其中 10 条在 `tests/cases` 或夹具中已有引用；`RF-SAN-001` 在用例和夹具中均无引用（只在 A79/A102 的 ID 清单里出现过编号）。
- 新增 A161（制裁命中且人工未排除 → 权重 5、风险分 70、等级高）与 A162（同名不同国家/主体，人工排除 → 不计分；脚本只输出 `requires_manual_review`，由 A25 与 A163 覆盖）。

### N-04b 评测语料

`tests/eval/inquiries.jsonl` 从 45 条扩到 **85 条**（E001–E085）：

| 类型 | 数量 | 说明 |
| --- | --- | --- |
| 非目标类 | 15 | 供应商推销 4、疑似同行 4、钓鱼型 3、个人调研 2、自动提交 2 |
| 目标类 | 6 | 终端用户项目 3、分销/安装商 3 |
| 新兴市场小买家反例（`segment: emerging_small_buyer`） | 12 | 阿拉伯语/越南语/印尼语/葡语/土耳其语/西班牙语、免费邮箱、无官网、WhatsApp 起手 |
| 既有红旗近似但不命中 | 7 | 合法新域名、回拨确认的账户变更、买方指定货代、普通大单有砍价、单一社媒但有官网、小买家免费邮箱、同名不同公司 |

新增字段：`expected_lead_signals`、`expected_lead_class`、`lang`；旧 45 条不改。

### N-04c 评分器

`tests/eval/score_eval.mjs` 增加：类别级精确率/召回率、混淆矩阵、`emerging_small_buyer` 误分比例（目标 ≤5%）。有预测文件且带 `lead_class` 时才计算类别指标；**不作为 CI 门槛**。

### N-04d 文档

`docs/validation.md` 新增第 8 节：红旗样本覆盖、8 类别自检指标、新兴市场反例 0/12、已知局限。

## 2. 验证

- `node tests/eval/score_eval.mjs --self`：通过；85 条、53 条正常、类别 40/40 有预测、混淆矩阵对角、误分 0/12。
- `node tests/run_cases.mjs`：A161/A162 通过；全量 178/178。
- 新增语料中公司名虚构、域名 `.example`、电话保留号段；未出现真实客户信息。

## 3. 遗留

- `automated_submission` 依赖 `form_meta.honeypot_triggered`，纯文本评测看不到表单信号；已在 `validation.md` 记为已知局限。
- 类别由模型勾选信号、脚本推导；模型抽取波动需真实数据继续校准。