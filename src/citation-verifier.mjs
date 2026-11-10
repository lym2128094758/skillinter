import {createHash} from 'node:crypto';
import {object, validate} from './schema.mjs';

const text = maxLength => ({type: 'string', minLength: 1, maxLength});
const citationSchema = object({path: text(300), line: {type: 'integer', minimum: 1},
  quote: {...text(4000), minLength: 5}});
export const findingsSchema = {type: 'array', minItems: 1, maxItems: 100, items: object({
  id: text(100), status: {enum: ['verified', 'missing', 'uncertain']}, claim: text(8000),
  evidence: {type: 'array', minItems: 1, maxItems: 20, items: citationSchema},
})};
const lines = text => text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);

export function readCitationReceipts(events) {
  return events.flatMap(({seq, type, payload}) => {
    const file = type === 'tool_result' && payload.name === 'read_file' && payload.output?.ok && payload.output.data?.file;
    return file ? [{seq, path: file.path, sha256: file.sha256, offset: file.offset,
      linesReturned: file.lines_returned, partialLastLine: file.partial_last_line, excerpt: file.content}] : [];
  });
}

export function parseCitationAnswer(answer) {
  const candidates = [answer, ...Array.from(answer.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi), match => match[1])];
  const matches = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && !Array.isArray(parsed) && Object.hasOwn(parsed, 'findings')) matches.push(parsed);
    } catch { /* Other prose and code blocks do not declare a findings report. */ }
  }
  return matches.length === 1 ? matches[0] : matches.length ? {findings: null} : null;
}

// Only the current run's read ranges can substantiate a citation. The caller
// rereads sources through its own permission checks; expected answers are absent.
export async function verifyCitations(findings, {receipts, loadSource, signal}) {
  const output = {status: 'failed', findings: structuredClone(findings), corrections: [], issues: [], sources: []};
  const add = (id, code, message, status = 'failed') => output.issues.push({id, code, message, status});
  if (validate(findingsSchema, findings).length || findings.reduce((sum, item) => sum + item.evidence.length, 0) > 200 ||
      new Set(findings.map(item => item.id)).size !== findings.length) {
    add('', 'CITATION_SCHEMA', '引用清单格式无效，或存在重复项目。');
    return output;
  }
  const sources = new Map();
  for (const item of output.findings) {
    for (const citation of item.evidence) {
      signal?.throwIfAborted();
      const reads = receipts.filter(receipt => receipt.path === citation.path);
      if (!reads.length) {
        add(item.id, 'SOURCE_NOT_READ', '本轮没有读取引用文件：' + citation.path);
        continue;
      }
      if (!sources.has(citation.path)) {
        const source = await loadSource(citation.path);
        if (source.error) sources.set(citation.path, {error: source.error.message});
        else {
          try {
            const content = new TextDecoder('utf-8', {fatal: true}).decode(source.bytes);
            sources.set(citation.path, {lines: lines(content), sha256: createHash('sha256').update(source.bytes).digest('hex')});
          } catch { sources.set(citation.path, {error: '引用源不是有效 UTF-8 文本。'}); }
        }
      }
      const source = sources.get(citation.path);
      if (source.error) {
        add(item.id, 'SOURCE_UNAVAILABLE', source.error, 'unknown');
        continue;
      }
      const current = reads.filter(receipt => receipt.sha256 === source.sha256);
      if (!current.length) {
        add(item.id, 'CITATION_SOURCE_CHANGED', '引用文件已在读取后变化：' + citation.path);
        continue;
      }
      const quote = citation.quote.trim();
      const matches = new Set();
      for (const receipt of current) {
        const excerpt = lines(receipt.excerpt).slice(0, receipt.linesReturned);
        if (receipt.partialLastLine) excerpt.pop();
        for (const [index, line] of excerpt.entries()) {
          const lineNumber = receipt.offset + index + 1;
          if (line.includes(quote) && source.lines[lineNumber - 1]?.includes(quote)) matches.add(lineNumber);
        }
      }
      if (matches.has(citation.line)) continue;
      if (matches.size !== 1) {
        add(item.id, matches.size ? 'AMBIGUOUS_CITATION' : 'CITATION_NOT_FOUND',
          (matches.size ? '引用原文在已读范围内不唯一：' : '已读范围内找不到引用原文：') + citation.path);
        continue;
      }
      const [resolvedLine] = matches;
      output.corrections.push({id: item.id, path: citation.path, quote: citation.quote,
        originalLine: citation.line, resolvedLine});
      citation.line = resolvedLine;
    }
  }
  output.sources = [...sources].filter(([, value]) => !value.error).map(([path, value]) => ({path, sha256: value.sha256}));
  output.status = output.issues.some(issue => issue.status === 'failed') ? 'failed' : output.issues.length ? 'unknown' : 'passed';
  return output;
}
