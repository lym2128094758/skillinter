# 执行前冻结与实际产物验收

技能版本可以声明可选的 `delivery`。技能中心「创建 / 改进」中的「实际产物验收」可编辑、导入导出时随版本保存。用户按任务目标审核条件后再发布；宿主按条件独立重读文件，不采纳模型自报成绩。

```json
{
  "version": 1,
  "preserve_inputs": ["input.json"],
  "artifacts": [{
    "path": "report.json",
    "format": "json",
    "require_change": true,
    "checks": [
      {"kind": "json_type", "pointer": "/records", "expected": "array"},
      {"kind": "json_length", "pointer": "/records", "expected": "2"},
      {"kind": "json_equals", "pointer": "/mean", "expected": "3"},
      {"kind": "json_equals", "pointer": "/source", "expected": "\"input.json\""}
    ]
  }]
}
```

## 判据

- `text_contains / text_excludes`：UTF-8 文件正文中包含或不包含精确文本，`pointer` 必须为空。
- `json_equals`：解析 JSON，按 JSON Pointer 取得字段，比较预期 JSON 值；对象键顺序不影响结果，数组顺序影响结果。`expected` 是保存 JSON 值的字符串，不是可执行表达式。
- `json_type`：`object / array / string / number / boolean / null`。
- `json_length`：数组元素数或字符串 UTF-16 长度；预期为非负整数字符串。
- `json_citations`：`pointer` 指向 findings 数组，`expected` 必须为空。每项包含唯一 `id`、`status=verified/missing/uncertain`、`claim`、`evidence:[{path,line,quote}]`；quote 至少 5 字符，line 从 1 起。宿主通过当前轮 `read_file` 回执、读取范围及重新读取的源文件指纹核对原文。文件中的行号错误会返回 `CITATION_LINE_MISMATCH` 和建议行号，由 Agent 修复文件后重验；宿主不会悄悄改写产物。
- `preserve_inputs`：执行前后同一路径的文件字节 SHA-256 必须相同。
- `require_change=true`：产物须由不存在变为可读文件，或其字节不同于执行前状态。已有且未变的旧报告不能冒充本轮新交付。

最多 4 份原始输入、4 份产物，每份产物 1–12 条检查，总声明限 24,000 字符。路径必须是普通项目相对路径，不能含隐藏目录、链接、凭据路径或越界；输入与输出路径不能重叠。沿用项目读取权限和 1 MiB 文件限制，不执行脚本、表达式或网络请求。当前支持 text / json，其他格式不会被当作内容正确性通过。

## 运行时

1. 加载技能时固定该版本契约和文件执行前状态，写 `skill_delivery_prepared`，不保存原始输入内容。
2. `verify_skill_output(skill_id)` 重新读取文件，返回统一 `{ok,data,error}`。`data` 包含契约指纹、是否提前冻结、执行前后文件指纹和逐项检查。
3. `finish_skill(status=applied)` 对有声明的技能自动重验；未通过或未确认不能标记已应用。验收工具的回执自身不能替代实际任务操作回执。
4. 任务结束前再验一次。此前通过、后来文件被更改的技能会撤销应用状态并记录失败。即使模型跳过 `finish_skill`，最终回复和技能链仍显示验收结果。
5. 原始日志保留失败→修复→通过的过程；下载的 `skill-execution.json` 包含冻结条件和最终检查。后续提炼候选时会附来源任务的实际产物检查，界面与候选文本对照分开呈现。

`passed` 只表示这些已声明条件满足；`failed` 表示至少一项明确不符；权限、大小、读取中断、执行后补条件等无法核验时为 `unknown`；没有声明为 `unspecified`。JSON 格式失败、输出缺失、原始输入变化均不能通过。操作错误码与工具完整 JSON Schema 见自动导出的 [工具契约](tool-registry.json)。

## 证据边界

固定的预期值适用于有明确目标的小任务，不能据此声称已实现通用数据真值推导。复杂统计还需要独立参考算法或数据快照。原始输入指纹相同只证明验收时字节相同；不证明中间从未短暂改写或副作用不存在。单次产物通过不证明技能具有因果贡献、跨任务提升或网络排序应该更新。候选与原技能可在冻结的独立材料及同一预算下执行配对验证；没有增益、回退或无法核实的结果均不得冒充改进。

## 普通聊天引用

主聊天最终回复声明 JSON `{"findings":[...]}` 时，也会走同一核验器，支持纯 JSON 或单个 JSON 代码块。若格式不合规、引用未读文件、源文件变化、原文不在已读范围或存在歧义，运行显示核验未通过。唯一命中的原文允许校准聊天回答的行号，原始回答与校准详情另存为 `citation-verification.json`；页面显示「引用原文核验」并提供下载。普通散文回复不会因此自动获得核验标记。

该核验确认的是原文、行号及来源，不判定 claim 的推理是否成立，也不把 missing/uncertain 改为 verified。`json_citations` 文件验收仍以实际文件字节为准，不能借聊天校准替代修改文件。
