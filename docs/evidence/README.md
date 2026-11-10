# 只读核验入口

最新的复现材料审查见 [DeepSeek 单 Agent / Worker 三轮对照](repro-audit-20261110/README.md)。第三轮单 Agent 原始严格得分 2/6，四条行号经真实读取回执唯一定位后交付为 6/6；三轮 Worker 均未通过。引用校准目前只在复测脚本中。代码与已验证范围见 [本轮审查入口](../review-status.md)。

在 SIH 的「项目只读」会话中，工作区是 `D:\gpt\projects`。请用相对工作区的路径读取。例如 `请用 read_file 读取 skillinter/docs/evidence/README.md`。代码对应 `skillinter/src/workflow.mjs` 和 `skillnet-demo/docs/architecture-review.md`。以下公开数据与测试记录已放入项目内，便于在该权限下核验。

本轮核验先读 [verification-summary.json](verification-summary.json)。新增一次真实 Chrome 附件上传、主输入框发送、真实 MiniMax-M3 服务、报告和图谱显示的完整联调，未打开预检表单。4 次真实模型请求的服务端响应均报告 `minimax-m3`，换算为 g → mg，3 行检出 3 个预设问题，原始列统计和图谱高亮与该次实际执行一致。输入明确为合成接口样例。

原始记录 [harness-browser-live.json](harness-browser-live.json) 包含起止时间、Chrome 和 Node 版本、每次真实请求的模型 ID、HTTP 状态及响应终态、逐文件源码指纹、UI 和业务结果。同批源码指纹的测试记录为 [test-run.json](test-run.json) 与 [原始 JUnit](test-run.junit.xml)，8 个测试文件中 28 个 `node:test` 用例通过，失败 0。这里的 28 指测试用例，不是 assert 断言次数。工作目录没有 `.git`，commit 为 null，使用源码 SHA-256 标识快照。复跑命令为 `npm run check:browser-live -- --model minimax-m3` 和 `npm run test:record`，前者会调用已配置的真实模型服务。

真实联调的 [聊天截图](harness-browser-live-chat.png) 与 [执行图截图](harness-browser-live-graph.png) 同该记录一起保存。下方的旧 API 实测和固定响应浏览器检查仍分别保留，不合并冒充同一次运行。

当前版请先读 [v4 两阶段规划的证据入口](v4/README.md)，唯一汇总为 [README 回归基线表](../../README.md#公开表回归基线)。下面表格保留 v3 与更早记录，分版本核验。

主聊天接入的真实联调见 [harness-chat-live.json](harness-chat-live.json)。使用 MiniMax-M3，通过普通聊天提交附件与自然语言目标，未传 workflow 表单。检索后调用预检，3 次外层和 2 次内部模型请求合计 5 次，正确得到 g → mg 的换算、3 个预设问题、原始列统计和成功执行图。一次重复预检命中本轮缓存。该样例是接口联调。

首轮真实联调只做了概览和读取，最后用“现在执行预检”结束，原始记录保留在 [harness-chat-first-attempt.json](harness-chat-first-attempt.json)。修复了执行预告提前结束的处理，并明确概览不能代替质量预检。随后用相同目标重测成功。Chrome 从主输入框发送消息、显示报告和图谱入口的检查见 [harness-chat-ui.json](harness-chat-ui.json)。界面检查使用固定响应测试服务。

| 检查 | 证据 |
| --- | --- |
| H3 项目只读错误码和当前 H8 提示词 | [h3-project-read.json](h3-project-read.json) |
| v3 同一批 10 张公开表的字段级对照 | [规则组](rules-v3-rerun.csv) · [MiniMax 组](minimax-m3-v3-rerun.csv) |
| 三条典型链路的配对消融 | [routing-paired.csv](routing-paired.csv) |
| 风洞表的输出预算失败 | [minimax-m3-v3-airfoil.json](minimax-m3-v3-airfoil.json) |
| 模型用量与估算费用 | [minimax-m3-v3-rerun-cost.csv](minimax-m3-v3-rerun-cost.csv) |
| 合成用例逐项结果 | [results.csv](results.csv) |
| 图谱回归和单端口离线核验 | [graph-ci.json](graph-ci.json) · [offline-demo-check.json](offline-demo-check.json) |
| 候选复用和旧版重放 | [reuse-shadow.json](reuse-shadow.json) · [legacy-replay-check.json](legacy-replay-check.json) |
| 历史模型连通性与 Intern-S2 当前实测 | [live-smoke.json](live-smoke.json) · [历史 180 秒尝试](intern-s2-run.json) · [当前 Iris 尝试](intern-s2-v3-iris.json) |

配对消融逐行记录输入和目标哈希。公开稻米表的两组均完成。单位明确的合成表上，规则组请求澄清，v3 已记录的 MiniMax 执行用 1 次模型调用选出正确的 g → mg 映射，检出两个预设问题。缺单位的合成表上，两组都被证据门拦截，模型调用 0 次。合成表的真值用于核验具体机制，公开表单独汇总。
