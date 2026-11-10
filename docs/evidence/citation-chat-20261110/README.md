# 主聊天引用核验

本轮使用真实 `deepseek-v4.1-flash-1017` 和 SIH 普通聊天 HTTP 入口，在隔离项目读取 `protocol.md`，核对 Python 版本。没有用固定模型响应替代。

- [完整聊天及事件](chat-live.json)：本轮读取、模型身份、根预算、引用核验、完成结果。
- [浏览器检查](chat-ui.json) 与 [截图](chat-citation.png)：Chrome 打开上述真实任务，显示「引用原文核验 · 通过」，下载记录后再次检查内容。
- [源码指纹](runtime.json)：基准提交与本轮实际文件版本，工作区修改不冒充已发布提交。

核验范围是引用原文、行号、已读范围和源指纹，不判定语义结论正确性。普通聊天允许唯一原文校准并保留原始回复；文件产物使用 `json_citations` 时必须实际修复文件。边界回归见 `skill-delivery.test.mjs`，经验线索回归见 `skill-experiences.test.mjs`。

## 技能改进实测

开发来源项目的 v1 技能方法只要求 README 初筛，但真实模型额外读取了依赖声明，已经正确交付。因此这次来源不能作为“原技能答错”的证据。后续纠正指出方法与实际执行不一致，候选须在两份独立材料上与原技能配对。没有改进不得发布，不把源码测试的夹具结果当成真实模型学习收益。

首次真实候选生成在 180 秒内未完成；缩短草稿后生成成功，记录见 [技能实测](learning-result.json)。独立对照开始后，用户要求超过一分钟按超时处理，已显式停止，保留 `interrupted/unknown`，候选未发布，复用未验证。后续脚本的候选生成、单轮聊天和整组对照均设 60 秒上限，不再继续长跑。正式库和用户安装技能未修改，测试数据库、凭据和示例技能包均不在本目录。

## 协作参考

已阅读 [OpenMausBot](https://github.com/milind-soni/OpenMausBot/tree/9d6678adcaf62645513a3e3419999134742bb458) 的 coordinator、runtime coordinator、room queue 和 turn timeout 实现，参考其任务归属、完成条件、真实排队状态及进展超时处理。该阅读不构成 SIH 已实现同等多 Bot 协作的证明，本轮先完成引用核验及候选验证。
