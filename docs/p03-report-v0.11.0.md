# N-03 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：官网表单元数据 `form_meta` 与 IP 脱敏（P0）
- 结论：**A156–A160、A170 通过；完整 IP 不进证据包；不代替独立审核。**

## 1. 做了什么

- 新增可选 `intake.form_meta`：`submit_ip_masked`、`referrer_domain`、`utm_source`、`landing_page_path`、`pages_viewed_before_submit`、`seconds_to_submit`、`honeypot_triggered`、`captcha_passed`、`ip_origin`。
- 纯函数 `mask_ip_network`：IPv4 → /24、IPv6 → /48；`--mask-ip` 可免证据包调用，Python/Node 一致。
- 证据包递归扫描完整 IP；发现即 `invalid-input`（`plaintext-ip`）。网段形式（`/n`）允许。
- 异常标记：`honeypot`、`fast-submit`（`seconds_to_submit` < 5）、`direct-no-browse`（0 页且无 referrer）。只作线索、不计分；只有 `honeypot` 触发 `automated_submission`。
- `privacy_scan.mjs` 增加完整 IPv4/IPv6 检测；保留网段与测试私有网段白名单，CIDR 形式跳过。
- `card_template.md` 2.2 增加字段与阈值说明。

## 2. 改动文件

- `scripts/render_card.py`、`scripts/render_card.mjs`
- `scripts/privacy_scan.mjs`
- `card_template.md`
- `tests/run_cases.mjs`（`mask_ip`、`privacy_ip` runner）
- `tests/cases/A156`–`A160`、`A170`

## 3. 验证

- A156 IPv4/IPv6 脱敏与非法输入，Python/Node 一致。
- A157 完整 IP → `invalid-input`（`plaintext-ip`）。
- A158 三个标记正反例与 4/5 秒边界。
- A159 `form_meta` 任意取值风险分/等级/置信度不变。
- A160 `honeypot` 触发自动提交；仅 `fast-submit`/`direct-no-browse` 不触发。
- A170 `privacy_scan` 对非白名单完整 IP 失败、对文档保留网段通过。
- 仓库 privacy 296 文件 clean；精简包 28 文件 clean。

## 4. 遗留

- `fast-submit` 与 `direct-no-browse` 阈值是初始值，需要 ≥50 条脱敏真实数据后校准。
- 精简包没有 `ip_check`；`form_meta.ip_origin` 由仓库内 `ip_check --online` 得出后粘贴，缺省 `not-covered`。