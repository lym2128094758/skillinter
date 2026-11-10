# 阶段 A：技能身份、关系与执行快照

## 实际改动

`src/skill-registry.mjs` 为身份、类型化关系与显式映射的共同入口。主聊天在开始时冻结注册表，路由与会话执行均使用这份快照；图谱同时从注册表投影执行关系。技能名不作为身份，版本以 UUID、版本号、正文指纹和项目归属记录。

已安装同名技能分别保留；自然语言仅点名而身份存在歧义时要求明确选择。项目覆盖必须显式选择“项目技能 → 用户技能”；覆盖只影响该项目的新任务，不删除用户版本或修改别的项目。

## 迁移规则

| 现有数据 | 处理 |
| --- | --- |
| `studio_skills` UUID / 版本 / 文件 | 原样保留，不复制、不合并、不改技能正文。 |
| SQLite `skill_graph_relations` | 保留为浏览关联，不能自动变成依赖。 |
| 正文提及与主题推测 | 保留为浏览关联。 |
| 静态 SkillNet 原目录 | 保留外部目录 ID；只有用户在详情中明确绑定本地 UUID，才映射关系。无论名称是否相同都不自动绑定。 |
| 未绑定的外部依赖 | 记录缺口并阻止该技能开始；不补造节点、不宣称已满足。 |
| 旧运行没有注册表快照 | 返回“历史运行没有注册表快照，不能用当前关系追认”，不回填当前配置。 |

新增三张配置表：`skill_typed_relations`、`skill_external_refs`、`skill_overrides`。配置每次编辑以预期 revision 做冲突检查，事务校验循环，失败回滚。旧表无破坏性迁移。

`depend_on` 的 source 依赖 target，执行 target → source；`compose_with` 只表示互补；`similar_to` 只表示替代。删除一个依赖节点或模型调用 `revise_skill_route`，都不能绕过本轮冻结的前置条件。

## 界面操作

技能图谱选择节点，在详情下方找到“身份与执行关系”。选择关系类型和目标技能，保存即可。第一项明确表示“当前技能依赖目标（目标先执行）”。同区可以移除本范围声明的关系、绑定或解除原目录身份；项目技能另有“显式声明项目覆盖”。用户范围继承的关系在用户范围编辑。

新关系沿用图谱自定义关联的显示开关；执行语义及方向在详情中逐条呈现。运行回复中的技能链提供“本轮冻结的技能关系”，可打开完整快照。编辑当前图谱不会更新历史回执或已运行任务的关系。

## API 契约

`GET /api/skill-registry/contract` 为机器契约，导出到 `docs/tool-registry.json` 的 `skillRegistry`。同源、Host 与 JSON 请求约束沿用主服务。所有以下读写仅修改技能配置或读取事件，不授予文件、网络或命令权限。

| 接口 | 参数 / 结果 |
| --- | --- |
| `GET /api/skill-registry` | 可选 `task` 或 `project` 查询参数；返回当前可见技能引用、关系、映射、覆盖、问题与 revision / sha256。 |
| `POST/DELETE /api/skill-registry/relations` | `{source,target,type,expectedRevision}`；source/target 必须是本范围真实 UUID。 |
| `POST/DELETE /api/skill-registry/bindings` | `{skillId,externalId,expectedRevision}`；仅固定 SkillNet 目录中的外部身份，不接受任意文件路径。 |
| `POST/DELETE /api/skill-registry/overrides` | `{projectSkillId,globalSkillId,expectedRevision}`；限所选项目技能覆盖用户技能。 |
| `GET /api/runs/:id/skill-registry` | 读取并核对该轮 `skill_registry_snapshot` 事件；不读取当前关系代替历史。 |

写入接口同样接受 `task/project` 查询参数。应用结果使用 `{ok,data,error:{code,message}}`。成功 error 为 `OK` / 空字符串；错误码表、参数/返回 Schema、超时方式、幂等性及授权在机器契约中定义。JSON/HTTP、任务范围不存在等运输/上下文错误沿用主服务通用错误处理。

快照按 UUID 与稳定键排序；时间不参加配置指纹。快照包含本轮全部可见身份与关系，路由只挑选少量候选；完整快照保存在本地事件和执行产物中，不整份塞入模型上下文。服务重启后可以从 SQLite 读取同一快照。新的技能正文或配置只影响新轮。

## 验证范围

`skill-registry.test.mjs` 覆盖：同名歧义、跨项目隔离、显式覆盖、外部身份绑定、旧关联保留、循环拒绝、过期编辑、互补/替代不变成依赖、运行中编辑隔离、防止调整计划绕过依赖、真实文件工具顺序变化、旧版本快照持久恢复、接口契约及同源入口。

真实文件执行测试使用确定性模型适配器调度真实 `read_file`，核对回执归属与 `finish_skill` 结果；不作为真实模型行为的证明。`scripts/check-graph.mjs` 在隔离状态目录启动 Chromium，操作图谱详情中的保存和移除按钮，并查询注册表确认落盘结果。测试均不导入用户真实技能或修改正式项目关系。

## 后续边界

阶段 A 不实现语义引擎、MCP、多模型、子 Agent 或长期记忆。原目录绑定仍限定当前内置目录；引擎升级时需显式审核外部 revision。原有独立对照证据按原来的指纹保留，本轮代码变化不追认旧报告为新版本结果。统一根任务预算账本在阶段 B 实施。
