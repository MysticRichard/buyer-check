# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.1.0] - 2026-10-21

MVP 首个版本。

### 新增

- `SKILL.md`：触发条件、5 步流程（采集 → 并行检索 → 交叉比对 → 评分 → 报告）、硬性约束、完成前自检清单。
- `red_flags.md`：12 条红旗清单（编号 `RF-<类别>-<序号>`）、判断细则、权重与四级等级划分。
- `data_sources.md`：RDAP/WHOIS、DNS、负面信息、制裁名单等公开入口，以及查不到时的降级做法。
- `report_template.md`：报告固定结构、追问话术模板、按等级的收款建议、措辞规范与文件命名规则。
- `scripts/whois_lookup.py` / `.mjs`：域名注册信息与 DNS 查询，支持 `--rdap-json` 离线 fixture。
- `scripts/domain_similarity.py` / `.mjs`：仿冒域名识别（同形字符、编辑距离、连字符、换后缀）。
- `scripts/risk_score.py` / `.mjs`：确定性评分与敏感信息脱敏。
- `scripts/red_flags.json`、`scripts/brands.json`：机器可读红旗表与知名品牌域名清单。
- `tests/`：验收用例 A1–A7 及离线运行器 `tests/run_cases.mjs`。
- `examples/sample-report.md`：脱敏样例报告。
- `docs/development.md`：开发文档。
- `README.md`、`LICENSE`（MIT）、`.gitignore`。

### 设计说明

- 评分只依据 `red_flags.md` 与 `red_flags.json`，不依赖模型临场判断，保证可复现。
- Python 与 Node 双实现，逻辑同构，便于在无 Python 环境时验证。
- 查不到信息时统一输出「未查到」或 `status: "unavailable"`，不编造。

### 计划中（未实现）

- V2：接入各国企业注册库（OpenCorporates、Companies House 等）与制裁名单 API；红旗清单扩充至 20+ 条。
- V3：材料真伪辅助（证书编号反查、PDF 元数据/版式异常检测、付款水单提示）。