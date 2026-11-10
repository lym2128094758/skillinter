# 复现材料审查的开发复测

本目录保存三轮 DeepSeek 真实模型对照，材料固定为 SkillNet 的公开提交 `0af2de6a9c8b129e174e3442b67c5f7cb4324db9a`。执行使用 SIH 的 `executeRun`、项目只读工具和根任务预算。模型生成结论，宿主按固定材料与真实读取回执核对六项要求。

## 三轮结果

| 协议 | 方式 | 原始严格得分 | 引用校准后 | 秒 | 模型请求数 |
| --- | --- | --- | --- | --- | --- |
| [第一轮](deepseek-off-20261110-192654/protocol.json) | 单 Agent | 3/6 | 4/6 | 94.4 | 2 |
| 第一轮 | Worker | 0/6 | 0/6 | 130.3 | 4 |
| [第二轮](deepseek-v2-20261110-193114/protocol.json) | 单 Agent | 5/6 | 5/6 | 31.9 | 2 |
| 第二轮 | Worker | 0/6 | 0/6 | 105.8 | 6 |
| [第三轮](deepseek-v3-20261110-193424/protocol.json) | 单 Agent | 2/6 | 6/6 | 113.1 | 2 |
| 第三轮 | Worker | 0/6 | 0/6 | 99.2 | 4 |

原始严格得分同时要求状态、原文及行号正确。第三轮六项状态正确，四条引用的原始行号少 1。校准只从本轮读取且指纹匹配的回执中查找引用原文，唯一命中时修正行号；存在歧义或找不到原文时保留失败。它不修改状态和结论，评分答案不参与定位。

第三轮的 [原始单 Agent 记录](deepseek-v3-20261110-193424/single.json)、[交付结果](deepseek-v3-20261110-193424/single-delivery.json) 与 [四条校准记录及原始分数](deepseek-v3-20261110-193424/single-verification.json) 分开保存。

三轮 Worker 均未交付通过结果，分别发生 `WORKER_TIMEOUT` 和 `INCOMPLETE_MODEL_OUTPUT`。后者对应模型返回 `finish_reason=length`。读取回执仍然存在，分析失败不能表述为宿主没有读取文件。具体时间线见各目录的 `workers-events.json`，请求与预算汇总见 `workers.json`。

## 运行条件及范围

模型均为 `deepseek-v4.1-flash-1017`，每组最多 6 次模型请求，服务商限流重试占用请求数。任务预算采用工作台的 900 秒。Worker 保持每批 45 秒、每个 1200 输出 tokens 的实现限制。

第一、二轮发送关闭思考参数，但模型目录只声明默认思考，参数是否生效未确认。第三轮使用默认思考。三轮逐步明确状态定义、行号计算与输出长度，差异不能归因于单一设置。这六项是开发用例，尚无独立任务集验证。

上述历史运行时引用校准只在复测脚本中，未接入主聊天。后续版本已将同一核验逻辑接入主聊天及产物验收，见 [产物验收说明](../../skill-delivery.md)。历史记录不据此追认完整联调通过。此处未执行目标项目的 pytest。三轮协议保留运行时的基准提交，第三轮 [代码指纹](deepseek-v3-20261110-193424/verification-runtime.json) 另记录校验时的工作区文件版本。

## 离线重验

准备含上述固定提交的 SkillNet 本地仓库，然后在 Skillinter 根目录运行以下命令。把第一个参数替换为本机源码目录。

~~~powershell
node scripts/check-repro-audit.mjs ../skillnet-demo docs/evidence/repro-audit-20261110/deepseek-v3-20261110-193424 deepseek-v4.1-flash-1017 --verify
~~~

重验不调用模型，会核对输入指纹、重算原始得分，再生成交付结果与引用核验记录。第三轮应报告单 Agent `accepted=true`、Worker `accepted=false`，进程退出码为 1。请求状态为 `completed` 不能替代任务验收。

真实重跑时去掉 `--verify`，并使用新的输出目录。模型凭据通过已保存的本机配置读取。
