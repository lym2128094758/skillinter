# SkillNet 检索、公开来源与候选生成

SIH 通过受管 Python 子进程调用用户配置的 SkillNet checkout 中的原始 `Retriever`、`SkillLibrary`、`Skill` 和 `skill_discovery`。Python 每次处理一个有界请求，退出后由宿主回收。传输为本机 JSON 行协议。依赖关系、权限、正式技能库和发布由 SIH 管理。

## 使用

1. 在「设置 → 模型 → SkillNet 技能引擎」填写源码根目录，以及安装了该项目依赖的 Python 程序。
2. 检测引擎，确认版本和编码器状态，保存并启用。修改从新一轮起生效。也可通过 `SIH_SKILLNET_PATH` 和 `SIH_SKILLNET_PYTHON` 提供初始配置。
3. 新任务将可用技能卡的 UUID、版本、名称、描述和冻结关系提交给检索模块。SkillNet 用原 BM25、向量和结构信号融合，关系扩展提供候选。宿主继续检查准入、硬依赖和实际回执。弱词面信号可空选，词法回退不采用仅由向量噪声召回的无关条目。
4. 从「技能中心 → 导入 → SkillNet 公开技能来源」选择公开能力标签，填写最多两个明确的 GitHub SKILL.md 来源链接并授权读取。
5. 预览固定的提交 SHA、原文、正文哈希和许可哈希。勾选审核后导入新技能，不覆盖同名条目。下一轮可明确选择导入的技能使用。

本次实测使用 SkillNet checkout 提交 `0af2de6a9c8b129e174e3442b67c5f7cb4324db9a` 和本机已有的 multilingual-e5-small ONNX 权重。隔离 Python 环境需要的直接依赖固定在 `requirements-skillnet.txt`，可用该 Python 执行 `-I -m pip install -r requirements-skillnet.txt`。桥接器始终以 `-I` 启动，因此用户级 site-packages 中的依赖不算已安装。编码器加载时由原模块校验权重清单中的文件哈希。

公开发现第一版核验用户指定的公开链接。远端返回的信息是未验证资料。仅导入 SKILL.md 正文，页面标明配套脚本和资料需另行补齐，实际任务仍受文件、命令和资源能力限制。

## 隔离、回退和用量

宿主不向引擎传送模型密钥或原始项目文件。检索只使用技能卡，显式发起变异时才读取被冻结的原技能正文。原 SkillNet 的应用配置在适配进程中被宿主配置替代，跳过其 .env 和正式技能库加载。LLM 重排关闭，因此当前检索不增加模型请求。稠密编码器缺失时保留真实的 `lexical-hashing` 标志和失败原因。缓存放在 SIH 状态目录内。

公开来源的网络请求由 SIH 限制到用户授权仓库的 `https://api.github.com` 元数据、提交、许可和 SKILL.md 接口。拒绝重定向，每份响应最多 256 KiB，单次发现最多 8 个请求。SkillNet 原有逻辑继续核对 Git blob SHA、固定提交、MIT 等允许的许可及正文内容。可通过宿主环境变量 `SIH_GITHUB_TOKEN` 提高 GitHub API 限额。凭据只进入固定 GitHub API 请求头，不传给 Python、不保存到引擎设置、不显示到回执中。

搜索尝试计入当前根任务的 engineCalls，停止信号终止子进程与网络请求。公开发现是一轮独立记录，与当前任务关联，模型调用预算为零。结果按项目范围持久化。引擎失败和回退分别记录 `skill_engine_details`、`skill_engine_call`、`skill_engine_fallback`。网络限流或许可无法核验时明确失败，不生成已导入状态。

## 接口

| 接口 | 实际作用 |
| --- | --- |
| GET /api/skill-intelligence/settings | 查看当前启用状态和配置修订号 |
| POST /api/skill-intelligence/settings | 乐观锁保存 enabled、sourcePath、python、encoder |
| POST /api/skill-intelligence/test | 检测实际 Python、原模块、版本和编码器 |
| POST /api/skill-intelligence/discover | 按已确认的标签和来源预览，返回预览 ID、运行 ID 与候选 |
| GET /api/skill-intelligence/discoveries/:id | 按项目范围恢复原预览、原文和导入记录 |
| POST /api/skill-intelligence/discoveries/:id/import | 明确确认后导入一个候选，记录来源和新版本，重复提交复用结果 |

接口仍执行同源和本机访问检查。检索与发现不将外部建议转成新权限。原 SkillNet 的 compose_with 不作为先后顺序，实际硬依赖仍以阶段 A 的冻结关系为准。

## 经验蒸馏与变异

在「技能中心 → 经验」查看来源，再选择「SkillNet 蒸馏为新技能」或「SkillNet 变异现有技能」。蒸馏以脱敏后的目标和线索为输入。变异限同一作用范围内实际参与的技能，核对原运行快照的 UUID、版本和正文指纹，保留原技能名、适用条件与产物验收。当前会话选定的模型处理这些摘录和原技能正文。

Python 调用原版 `SkillEvolver.distill` 或 `SkillEvolver.mutate`。原算子的准入检查在候选模式运行，SIH 接收候选并负责持久化。变异允许草案与原方法高度相似。生成的关系和质量评级不进入正式关系或路由。每次提案有独立运行记录，限 180 秒、1 次逻辑模型请求、最多 3 次 HTTP 尝试，每次输出上限 3500 tokens。停止会取消引擎和模型请求。

候选记录来源、算子、引擎源码指纹和版本、冻结快照、原技能指纹和字段差异。生成的两个文本样例是试跑建议。发布前还需在「实际任务对照」中使用独立材料冻结验收、证明改进并人工确认。候选修订沿用这一发布条件。

## 验收

`npm test` 包括共享预算、引用越界、取消、快照以及引擎选中 UUID 后按依赖真实读取文件的检查。公开来源测试验证预览隔离、项目范围、确认导入及来源记录。

`node scripts/check-skillnet.mjs <SkillNet目录> <Python程序>` 使用原模块与本地 HTTP 模型夹具，检查检索、回退、文件回执、蒸馏和变异，并验证无证据的候选无法发布。提供宿主 `SIH_GITHUB_TOKEN` 时，还会实际读取公开 GitHub 来源，固定提交及许可，确认导入后验证下一轮技能采用。报告保存到 `.skillinter/evaluation/phase-d-live.json`。模型夹具用于验证链路，技能收益由独立任务对照评估。
