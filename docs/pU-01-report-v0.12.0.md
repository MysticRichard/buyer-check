# U-01 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 基线：`8ab0c76`（v0.11.0）
- 任务：可注册域名覆盖全球后缀（P0）
- 结论：**内置 81 条公共后缀快照；`render_card` 与 `domain_similarity` 使用同一张表；A190–A196 通过。**

## 1. 做法

- 从 Public Suffix List 官方列表核对后，选取 20 国 + 常见外贸市场（土耳其、墨西哥、阿根廷、智利、哥伦比亚、秘鲁、巴基斯坦、孟加拉、斯里兰卡、尼日利亚、肯尼亚、埃及、摩洛哥、沙特、阿联酋、俄罗斯、乌克兰、波兰、韩国、日本、南非、马来西亚、印尼、泰国、越南、菲律宾、卡塔尔、科威特、巴林、阿曼、黎巴嫩、利比亚）的二级公共后缀；保留原有 17 条，共 **81 条**。
- 内置 `MULTI_SUFFIX`（Python/Node）与 `PUBLIC_SUFFIXES`（`domain_similarity.py/.mjs`）；`domain_similarity.core_label` 改为使用同一张表。
- 不处理完整 IDN/punycode 规则；`xn--` 不崩溃。

## 2. 验证

- A190 `acme.com.tr` / `www.acme.com.tr` → `acme.com.tr`。
- A191 `com.mx` 邮箱/官网域一致。
- A192 `acme.co.za` vs `acme.com` 仍不同。
- A193 `a.b.example.co.uk` → `example.co.uk`。
- A194 表驱动：81 条后缀 × 正例/带 www 各一条，Py/Node 一致。
- A195 `card_harbor` 旧卡字节不变；全量 210 用例 0 失败，未发现旧输出变化。
- A196 8 个市场的 Py/Node 一致。

## 3. 遗留

- 公共后缀表是“常见二级后缀”子集，不是完整 PSL；城市/地区级后缀（如日本地区域、巴西城市域）未收录。
- 未处理 IDN 完整规则；`xn--` 只保证不崩溃。
- 文档数字（A1–A210 等）留 D 系列同步。