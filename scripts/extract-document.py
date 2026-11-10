"""Read bounded office XML without executing macros, formulas, or embedded code."""
import sys, json, zipfile, xml.etree.ElementTree as ET

kind, path, offset, limit = sys.argv[1:]
offset, limit = int(offset), int(limit)
z = zipfile.ZipFile(path)
xml_budget = 32 * 1024 * 1024
def xml(name):
    global xml_budget
    xml_budget -= z.getinfo(name).file_size
    if xml_budget < 0:
        raise ValueError('XML_TOO_LARGE')
    b = z.read(name)
    if b'<!DOCTYPE' in b.upper() or b'<!ENTITY' in b.upper():
        raise ValueError('XML_ENTITY_NOT_ALLOWED')
    return ET.fromstring(b)
def local(tag):
    return tag.split('}')[-1]
lines = []
total = 0
has_text = False
remaining = 24000  # at most 48000 UTF-16 code units in the tool result
clipped = False
def add_line(value):
    global total, has_text, remaining, clipped
    has_text |= bool(value.strip())
    if offset <= total < offset + limit and not clipped:
        if lines:
            remaining -= 1
        if len(value) > remaining:
            clipped = True
        lines.append(value[:max(0, remaining)])
        remaining -= len(value)
    total += 1
if kind == 'docx':
    root = xml('word/document.xml')
    for p in root.iter():
        if local(p.tag) == 'p':
            add_line(''.join((t.text or '') for t in p.iter() if local(t.tag) == 't'))
elif kind == 'xlsx':
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in xml('xl/sharedStrings.xml'):
            shared.append(''.join(t.text or '' for t in si.iter() if local(t.tag) == 't'))
    rels = {r.attrib['Id']: r.attrib['Target'] for r in xml('xl/_rels/workbook.xml.rels')}
    for s in xml('xl/workbook.xml').iter():
        if local(s.tag) != 'sheet': continue
        rid = next((v for k, v in s.attrib.items() if local(k) == 'id'), '')
        target = rels[rid]
        name = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        if '..' in name.split('/') or name not in z.namelist(): raise ValueError('INVALID_SHEET')
        add_line('[Sheet: ' + s.attrib.get('name', '') + ']')
        for row in xml(name).iter():
            if local(row.tag) != 'row': continue
            cells = []
            for c in row:
                value = ''
                for v in c:
                    if local(v.tag) == 'v':
                        value = v.text or ''
                        if c.attrib.get('t') == 's': value = shared[int(value)]
                    elif local(v.tag) == 'is': value = ''.join(t.text or '' for t in v.iter() if local(t.tag) == 't')
                    elif local(v.tag) == 'f': value = '[formula; cached value follows]'
                cells.append(c.attrib.get('r', '') + '=' + value)
            add_line('\t'.join(cells))
print(json.dumps({'totalLines': total, 'linesReturned': len(lines), 'text': '\n'.join(lines),
                  'truncated': clipped or total > offset + limit} if has_text else {'error': 'NO_TEXT'}, ensure_ascii=False))
