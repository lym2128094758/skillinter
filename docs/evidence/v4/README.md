# v4 两阶段规划证据

唯一成绩汇总在 [README](../../../README.md#公开表回归基线)。每个实验条件是相同 10 张公开表、20 个映射决策，各运行一次。以下 CSV 每个目标字段一行，JSON 保存全部记录、源快照指纹、数据行指纹、用量、耗时及终态。`npm run check:scores` 重算六组结果并核对 README。

| 组别 | 原始表头 | 中文表头 |
| --- | --- | --- |
| 规范化精确匹配 | [逐字段 CSV](rules-v4-final.csv) · [JSON](rules-v4-final.json) | [逐字段 CSV](rules-headers-v4-final.csv) · [JSON](rules-headers-v4-final.json) |
| 开发集适配词典 | [逐字段 CSV](rules-dictionary-v4-final.csv) · [JSON](rules-dictionary-v4-final.json) | [逐字段 CSV](rules-dictionary-headers-v4-final.csv) · [JSON](rules-dictionary-headers-v4-final.json) |
| MiniMax-M3 真实调用 | [逐字段 CSV](minimax-m3-v4-final.csv) · [JSON](minimax-m3-v4-final.json) | [逐字段 CSV](minimax-m3-headers-v4-final.csv) · [JSON](minimax-m3-headers-v4-final.json) |

词典由开发者查看这批目标后适配，范围和局限见 [验收说明](../../validation.md)。中文变体的全部表头改写公开在 `bench/header-variants.mjs`，数据行逐字节保留，目标 schema 不变，传给模型的文件名使用匿名编号。训练集重叠未知。

## 失败修复与可复现记录

- 风洞表的最终真实响应见 [录制回放](minimax-m3-v4-final-airfoil-1-replay.json)，阶段依次为 `mapping` 和 `steps`。修复前 v3 截断保留在 [原失败报告](../minimax-m3-v3-airfoil.json)。
- 第一版拆分仍出现 Schema 复述和过严的依据长度限制。中间完整开发轮保存在 [原表头组](development/minimax-m3-v4-split.json) 和 [变体组](development/minimax-m3-headers-v4-split.json)，失败响应见 [风洞](development/minimax-m3-v4-split-airfoil-1-replay.json) 和 [葡萄干](development/minimax-m3-v4-split-raisin-1-replay.json)。这些轨迹用于查看开发过程，重跑需要对应运行器，当前成绩只采用最终版同一冻结轮次。
- `OUTPUT_TRUNCATED` 在映射或可选步骤阶段都会终止执行，保留原始响应。Chrome 真实点击「扩大预算重试」的结果见 [界面检查](retry-ui.json)。测试服务第一次返回截断，后续两次请求的输出额度扩为默认两倍，原 CSV 保持相同。
- Intern-S2 最终最小映射请求仍无数据返回。见 [失败报告](intern-s2-v4-final-n1-iris-1-report.json) 和 [请求及观测](intern-s2-v4-final-n1-iris-1-replay.json)。该记录的空闲超时不具有原样离线重跑能力。
- [原表头成本](minimax-m3-v4-final-cost.csv) 和 [变体成本](minimax-m3-headers-v4-final-cost.csv) 按服务商实测 token 与配置的冻结价目估算，币种是墨点，实际扣费以账单为准。
- 逐字段评测 CSV 的 `cost` 列留空，表示运行器当时未配置折算价，不代表零费用。以表的 `table` 字段关联上述 `*-cost.csv` 的 `estimatedCost`。保留原始运行记录，折算成本单列记录。
- [当前三条链路对照](routing-paired.csv) 包含公开稻米、单位明确的合成表和单位缺失的合成表，逐行保存输入和目标指纹，合成表与公开表分开标记。

完整的真实成功响应可用同目录的 `*-replay.json` 在匹配源码下执行 `npm run demo -- <路径>`。源码哈希、注册表哈希、请求哈希、报告和图谱轨迹同时校验。旧版源码已单独封存。人工双人计时仍待参与者执行，不能从模型时延推导人工收益。
