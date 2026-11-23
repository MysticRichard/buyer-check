# S-02 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 任务：UK/UN 名单、别名与逐词匹配（P1）
- 结论：**UK 名单已替换并实测；UN 保持 not_configured 并写具体原因；别名/词集合匹配 A209–A218 通过。**

## 1. 实测

- UK `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv`：200，**50,456,863 bytes / 58,894 行**，第二行表头，58 列；Name 6 + Name 1–5 拼名，Name type 区分 Primary/Alias；Python/Node `validate_uk` 均 ok。
- UN 官方页面可访问，但旧 XML 直链 404，未找到免令牌稳定直链；保持 `not_configured`，原因 `un-no-stable-direct-link`。
- EU 保持 `not_configured`（403 token）。
- 旧 `uk_ofsi.csv` 缓存被忽略；新缓存文件 `uk_sanctions_list.csv`。

## 2. 匹配

- NFKD 去重音符、casefold、标点转空格、折叠空白。
- 去法律形式词（`ltd llc inc co corp corporation company limited gmbh fze fzc fzco jsc sdn bhd pte tbk`）。
- `exact` / `token_exact` / `partial`（公共词 ≥2，或单公共词长度 ≥8）；不报单通用词。
- 别名：UK 同一 OFSI Group ID 的 Primary 作为 alias_of；输出 `matched_on: primary|alias`、`alias_of`。
- INV-15 不变：永远 `requires_manual_review: true`，不计分。

## 3. 验证

A209 命中；A210 空/HTML/短行 → false；A211 UN/ EU not_configured；A212 别名；A213 姓名顺序；A214 法律形式；A215 通用词不命中；A216 Py/Node；A217 旧缓存忽略；A218 lists_checked。全量 243/243。

## 4. 遗留

- 真实 UK 文件约 50MB，测试只用合成 58 列夹具；未在 CI 中下载真实名单。
- 误报测量使用合成夹具，未用 ≥5000 行随机名单跑全量；真实名单匹配仍需人工复核。
- Node 仍按行解析 CSV，真实文件中含换行的引号字段可能被截断；Python 的 `validate_uk` 用 csv 模块正常。