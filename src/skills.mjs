const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const csvSkill = {
  id: 'xlsx', label: 'CSV 数据概览',
  reason: '任务要求分析表格，且选中了 CSV 文件。采用原技能库 xlsx 节点对应的本地 CSV 分析器。',
};

export function selectSkill(prompt, file) {
  return file?.kind === 'csv' && /统计|分析|概览|概况|汇总|均值|平均|缺失|描述性|summary|analy[sz]|mean|profil/i.test(prompt) ? csvSkill : null;
}

export function utf8(bytes) {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw new Error('文件须使用 UTF-8 编码'); }
}

export function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false, closed = false;
  function field() {
    row.push(value);
    if (row.length > 150) throw new Error('CSV 最多支持 150 列');
    value = '';
    closed = false;
  }
  function line() {
    field();
    if (row.length > 1 || row[0].trim()) rows.push(row);
    if (rows.length > 50_001) throw new Error('CSV 最多支持 50,000 条数据');
    row = [];
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') value += char;
      else if (text[index + 1] === '"') { value += char; index++; }
      else { quoted = false; closed = true; }
    } else if (char === ',') field();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      line();
    } else if (char === '"' && !value && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error('CSV 引号格式无效');
      value += char;
    }
  }
  if (quoted) throw new Error('CSV 有未闭合的引号');
  if (row.length || value || closed) line();
  const header = rows.shift()?.map(value => value.trim());
  if (!header?.length || header.some(value => !value) || new Set(header).size !== header.length) {
    throw new Error('CSV 第一行须提供非空且不重复的列名');
  }
  return {header, rows};
}

const oneLine = value => value.replace(/\s+/g, ' ').slice(0, 120);
const format = value => String(Number(value.toPrecision(12)));

export function analyzeCsv(file) {
  const {header, rows} = parseCsv(utf8(file.bytes));
  const stats = header.map(() => ({count: 0, blank: 0, other: 0, min: Infinity, max: -Infinity, mean: 0}));
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) throw new Error(`第 ${index + 1} 条数据有 ${row.length} 列，表头有 ${header.length} 列`);
    for (const [col, raw] of row.entries()) {
      const value = raw.trim();
      const stat = stats[col];
      if (!value) { stat.blank++; continue; }
      const number = numeric.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(number)) { stat.other++; continue; }
      stat.count++;
      stat.min = Math.min(stat.min, number);
      stat.max = Math.max(stat.max, number);
      stat.mean = stat.mean * ((stat.count - 1) / stat.count) + number / stat.count;
    }
  }
  const summary = `已完成 CSV 数据概览。共 ${rows.length} 条数据、${header.length} 列。报告包含每列的空值数、有效数值数、均值和范围。`;
  const lines = header.map((column, index) => {
    const {count, blank, other, min, max, mean} = stats[index];
    const metrics = count ? `；均值 ${format(mean)}；最小 ${format(min)}；最大 ${format(max)}` : '';
    return `${index + 1}. ${oneLine(column)}：空值 ${blank}；非数值 ${other}；有效数值 ${count}${metrics}`;
  });
  const report = ['CSV 数据概览', `输入文件：${file.name}`, `输入 SHA-256：${file.sha256}`,
    '技能节点：xlsx · Skillinter 本地 CSV 分析器', '', summary,
    '统计口径：首行为列名；全空白行忽略；均值与范围只计算有限数值；未填补缺失值。', '', ...lines, ''].join('\n');
  return {summary, report};
}
