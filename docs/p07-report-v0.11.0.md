# N-07 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：独立渠道验证动作与视频核验话术（P1）
- 结论：**A168–A169 通过；视频只增加冒充成本，不声称检测深度伪造。**

## 1. 做了什么

- `coverage.uncovered[].reason` 新增 `unverified-contact`；`REASON_TEXT` / `REASON_LABELS` 同步。
- `data-sources/global.md` 第十一节增加“独立确认”行：用官网公示的电话或邮箱（不是对方给的）联系一次，回传对方是否确认此人在职；排序改为地图、注册库、独立确认、领英和 Facebook，仍 ≤4 行。
- `render_card.py/.mjs` 新增 `VIDEO_SCRIPT` 常量与 `video_script` 输出；仅在 `inquiry_type` 为 `large_first_order`/`pre_order` 或等级为高/中时返回；卡片不自动加行（旧包字节不变）。
- `card_template.md` 话术库新增视频核验一条（英文 + 中文）。
- `report_template.md` 新增 6.2.1“视频核验建议”：官网邮箱发会议邀请、镜头前展示办公场所、问内部业务细节；明确“视频不是身份证据，只增加冒充成本；本 Skill 不做深度伪造检测”。

## 2. 改动文件

- `scripts/render_card.py`、`scripts/render_card.mjs`
- `data-sources/global.md`、`card_template.md`、`report_template.md`
- `tests/fixtures/card_unverified_contact.json`
- `tests/run_cases.mjs`（`video_script` runner）
- `tests/cases/A168`、`A169`

## 3. 验证

- A168 `unverified-contact` 一次动作：卡片含“▸ 独立确认”、行数 37（≤50）、首屏 10（≤14）；旧证据包字节不变（A146）。
- A169：general + 低 → 不出现；`large_first_order` / `pre_order` → 出现；高等级 + general → 出现；`account_change` + 低 → 不出现；英文/中文与禁用词检查通过。
- 全量仓库 178/178；包内通过。

## 4. 遗留

- 视频话术只作为可选建议，不自动插入卡片；模型按条件使用常量。
- 完整报告的“视频核验建议”由模型按模板生成，脚本不渲染报告。