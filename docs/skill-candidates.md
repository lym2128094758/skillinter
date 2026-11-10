# 候选改进接口

仅允许本机同源访问，使用现有服务的 Host / Origin 检查。`taskId` 为来源会话，`projectId` 为目标项目；项目候选只在该项目上下文可见，用户候选在本机各项目可见。候选隔离在私有 SQLite 中，不会被技能扫描或主聊天启用。

| 方法与路径 | 参数与结果 |
| --- | --- |
| `POST /api/skill-studio/candidates` | `draft` 使用现有技能草案 schema；`baseVersion` 必填，原技能改进提供 `skillId`；可选 `taskId / sourceRunId / projectId / targetScope / parentCandidateId`。返回冻结候选，含 `id / sha256 / draft / baseline / suite / sourceEvidence / trials`。同一冻结快照复用原编号。 |
| `GET /api/skill-studio/candidates?task=…&project=…` | 返回最多 100 项摘要，按创建时间倒序、编号排序。 |
| `GET /api/skill-studio/candidates/:id?task=…&project=…` | 返回候选及完整验证历史。修改须另存为新候选；旧记录不覆盖。 |
| `POST /api/skill-studio/candidates/:id/evaluate` | `taskId / projectId` 可选。按该会话选择或默认模型执行冻结文本用例，无客户端成绩参数。预算 180 秒；单响应 4096 tokens，截断时最多重试一次至 8192。每个用例两组顺序执行，交替先后。部分配对实时保存；中断保留记录，可重试。 |
| `POST /api/skill-studio/candidates/:id/promote` | 提交详情中 `publication.proof.trialId` 和 `confirmed=true`，可选上下文。若已有实际任务试验，以最新实际任务结果为发布依据。仅有文本试验时，沿用文本对照发布。发布前检查基线版本、执行指纹及冻结资源，登记新版本与审核依据。同次发布幂等，返回 `skill / candidate`。 |
| `POST /api/skill-studio/:id/restore` | 提交目标历史 `version`、当前 `baseVersion` 和 `confirmed=true`。恢复历史技能定义为一个新版本，保留原发布证据与当前配套文件。返回 `skill`，含 `restoration.fromVersion / previousVersion`。 |

结果枚举：`pending` 待测；验证中的 `status=running`；`verdict=improved / no_gain / failed / unknown` 分别为冻结文本用例新增通过且无回退、未测出增益、有失败或回退、证据不足。`status=interrupted` 表示验证未完成。它们不表示技能在其他任务上的效果。

至少两个不同、自包含的用例，每项需要验收条件。自动判据只有“包含：原文”和“不包含：原文”，其他条件记为 review，不能自动晋级。两组均须输出完整且报告相同模型。来源对话不能直接充当新增验证例；继承回归集中与来源重合的提示会标注且不计新增通过。没有独立真值或工具执行时，不能宣称正式留出评测或生产收益。

请求错误沿用应用 JSON `{error: message}`：422 格式、来源或用例问题；404 当前范围不可见；409 版本冲突、正在验证、缺少可发布证据或未连接模型；502/504 模型失败或超时。候选评测不是 Agent 工具，不改变文件工具的统一 `{ok,data,error}` 协议。时间、用量和时延为 volatile。

技能版本记录保存实际发布时选中的试验编号、证据范围及通过数。实际任务发布还保存计划和执行实现指纹。用户可从版本记录返回对应候选，核对模型、冻结材料、判据和产物。恢复历史定义后，下一轮使用新版本号，旧候选基线按版本冲突处理。
