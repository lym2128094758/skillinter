# Skillinter 验收与复现

目标使用者为实验室数据整理人员。输入是批次测量 CSV、检查目标和目标字段约束，输出为版本化字段映射、质量问题清单和原始记录引用。映射错误会让下游按错误列名或单位读数，因此含义不清时询问用户，建议映射由人复核。

人工耗时、错误率、每条复核耗时、复核率和推翻率尚未采集。后续由两名操作者对同一批表分别完成有系统和无系统两种条件的盲测，交叉分配顺序，记录用时、错误数、复核数及推翻数。按预先冻结的标注计分。模板见 [人工计时表](manual-baseline.csv)。

## 公开表对照

`bench/public-data/manifest.json` 冻结了 10 张表、9 个 UCI 来源，包含源页面、下载 URL、获取时间、原文件指纹、导出指纹、完整行数和标准映射。红、白葡萄酒是同一来源的两个子表。保留发布表头，依据来源的变量说明确定目标到来源列。每表 2 个目标字段。训练集重叠未知，结果限于本批公开数据及任务。

当前版的唯一汇总见 [README 回归基线表](../README.md#公开表回归基线)，逐字段记录见 [证据目录](evidence/README.md)。样本量是 10 张表、20 个映射决策。

前版 MiniMax-M3 的 20/20 字段、10/10 任务是历史记录，与当前版不可比，保留在历史产物中，不用于当前版成绩。修复前 v3 的风洞表两次响应均以长度上限结束，未生成可执行计划，原始失败保留在证据目录。

通过要求为两个字段均匹配标准映射、逐行校验覆盖全部记录、问题总数符合该批输入预期。规则组零模型调用。各组独立记录，精确匹配、开发集适配词典和模型均使用同一组数据。逐字段结果见对照 CSV。Iris、风洞等真实表各有可查 DAG。前版另有 Abalone 的修复轨迹及只给 `measurement` 时请求澄清的玻璃表记录，均属于历史试验。

新增一组中文表头变体：冻结替换词表后，只替换首行表头，原始数据行、目标字段和约束保持不变。每表单独核对数据行指纹，并将传给模型的文件名替换为匿名编号。替换词表与词典基线公开在 `bench/header-variants.mjs`。词典在开发者看过本批目标后编写，有评测适配，不能当作独立留出的泛化基线。它和模型在本批原表、变体上均完成，原精确匹配组的差距不足以证明模型优于词典。变体测的是改写鲁棒性，不能据此判定模型是否记忆过 UCI 数据。 [当前结果与口径](../README.md#公开表回归基线)

两阶段规划初稿还出现复述 JSON Schema 和依据长度过限的问题，中间轮结果与失败响应保存在 `evidence/v4/development/`。最终版加入实际实例说明，按失败阶段修复，不重做已通过的映射；当前成绩对应最后一轮完整固定测试，开发轮保留供追溯。

前版 Iris 同一输入单独运行 5 次，5 次任务通过，映射和问题数一致。36 条合成用例各重复 5 次是独立回归，180 次无崩溃，180 份报告通过字段校验，505 条需引用的结果全部绑定实际文件、哈希及记录。引用统计覆盖映射、问题、列统计和行数。通用幻觉率和人工效益仍需另测。

~~~powershell
npm run eval
npm run eval:public
npm run eval:public -- --model minimax-m3 --seconds 90 --tag v4-final
npm run eval:public -- --model minimax-m3 --count 1 --repeats 5 --seconds 60
npm run eval:public -- --model minimax-m3 --count 1 --full-context --seconds 60
npm run eval:public -- --model minimax-m3 --headers variants --seconds 90 --tag v4-final
npm run eval:public -- --baseline dictionary --tag v4-final
npm run check:scores
node scripts/cost-table.mjs minimax-m3-v4-final
~~~

## 模型与开销

### 当前复测与历史失败

修复前 v3 与拆分规划后的复测使用同一冻结数据和目标字段。当前汇总引用 [README 回归基线表](../README.md#公开表回归基线)，每个结果链接到对应版本的逐字段 CSV、响应和执行轨迹。旧轮的失败保留。 [逐字段对照](evidence/README.md)

此前用 v3 重试 Intern-S2，选择关闭思考、精简上下文与流式输出，任务总预算 180 秒。在 120.015 秒触发无新数据的连接保护，没有得到规划或用量。Intern-S2 在方案中预留为语义规划模型，负责字段含义匹配和可选步骤选择。本地工具负责检查、引用和停止。当前有实测完成记录的模型是 MiniMax-M3，可作为对照和一般部署选项。若比赛要求书生底模完成关键任务，现有证据不足以主张符合要求。补救已落实为两次小请求，先映射、再选择可选统计，宿主组装依赖，并重跑相同 Iris 输入。新的真实运行结果单独保存。运行降级提供确定性规则预检和离线记录演示，无法匹配时请求澄清。 [历史 v3 Intern-S2 记录](evidence/intern-s2-v3-iris.json)

### 前版对照与历史尝试

| 路径 | P50 / P95 | 平均输入 / 输出 token | 单表估算费用 |
| --- | --- | --- | --- |
| 规则对照，10 表 | 1 / 7 ms | 0 / 0 | 0 |
| MiniMax-M3，10 表 | 12.730 / 48.426 s | 1,326.4 / 1,505.7 | 0.01543332 墨点 |
| Intern-S2，Iris 完整尝试 | 180.010 s 到任务超时 | 用量未返回 | 未提供 |

MiniMax-M3 按实测 usage、未命中缓存单价 2.1 和输出单价 8.4 墨点/百万 token 估算，实际扣费以账单为准。服务端 GPU 和权重 SHA-256 未提供。[书生·端砚 TokenPlan 定价](https://discovery.intern-ai.org.cn/token-plan/home?dockey=04-model-limits-and-pricing.md&tabIndex=3)

同一 Iris 表、同一模型，完整契约与重复观测为 3,574 个输入 token，保留参数 schema 并去除重复观测后为 1,045 个，下降 70.8%，两次映射均正确。这是单表配对实测。录制回放核对输入、请求和结果指纹，避免同一演示重复请求 API。

v4 最终两阶段版本再次用 Intern-S2 跑相同 Iris，关闭思考，任务预算 180 秒。第一阶段仅请求两列映射，仍在 120.017 秒触发无新数据的空闲保护，没有计划或用量，第二阶段未发起。此前的拆分初稿也在 120.018 秒同样停止。缩短输出未解决该连接的等待问题，现有轨迹不能将原因归结为输出过长。保留最小请求、阶段、运行器哈希和失败报告供后续排查。书生关键任务的验收仍待成功运行。 [最终 Iris 失败报告](evidence/v4/intern-s2-v4-final-n1-iris-1-report.json)

v4 原始表头组的 P50/P95 为 7.264/13.642 秒，平均输入/输出 1,482.2/541.2 tokens，按冻结价目估算均摊 0.00765870 墨点/张。中文变体组为 11.431/15.213 秒，平均输入/输出 1,499.2/695.2 tokens，估算 0.00898800 墨点/张。都包含该轮全部 10 次任务，实际扣费以账单为准。 [成本明细](evidence/v4/minimax-m3-v4-final-cost.csv) · [变体成本](evidence/v4/minimax-m3-headers-v4-final-cost.csv)


## 目标环境和单端口演示

- Node.js 24.16.0，见 `.node-version`。应用使用 Node 自带 HTTP、SQLite 和现代浏览器，无第三方 npm 依赖。Windows 双击 `start.bat`，或运行 `npm start`。
- 3091 同时提供页面、`GET /api/health`、`POST /api/demo` 和文件证据接口。离线演示无需网络、GPU 或 API 密钥。健康接口的模型配置标志只表示是否配置。
- 在线模式使用自己的 API 密钥，模型权重由服务商托管。回放保存实际模型 ID、服务商指纹（若提供）、请求和响应。客户端无法核对远端权重哈希、显存和采样种子。离线夹具和规则不使用随机采样。 [TokenPlan 接入说明](https://discovery.intern-ai.org.cn/token-plan/home?dockey=07-agent-tools.md)
- `npm run demo`、`npm run eval` 和 `npm run eval:public` 的规则组均可离线重跑。`npm run demo -- <新版回放路径>` 验证真实响应录制。`make setup && make demo` 与 Windows 的 `npm run setup`、`npm run demo` 对应同一实现。
- 干净目录复现与第三方换机复现分别记录。未参与开发的操作者仍需按 README 实际计时。

README 有架构图、产物清单和失败案例。工具及权限变动的验收入口见 [H1–H10 自检](harness-checklist.md)。
