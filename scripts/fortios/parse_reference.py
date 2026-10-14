import re, collections
REF = '/home/user/ubuntu-sandbox/official_docs/forti-cli-ref-767.txt'
lines = open(REF, errors='ignore').read().split('\n')
NOISE = re.compile(r'^(FortiOS 7\.6\.7 CLI Reference \d+|Fortinet Inc\.|Parameter Description Type Size Default)$')

def section_bounds(title):
    syn = tab = None
    for i, l in enumerate(lines):
        if l != 'config ' + title: continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        if nxt.startswith('Description:') and syn is None: syn = i
        if nxt.startswith('Parameter Description') and tab is None: tab = i
    return syn, tab

def syntax_names(syn):
    depth = 1; stack = ['']; j = syn + 2; out = []
    while depth > 0:
        s = lines[j].strip(); j += 1
        if NOISE.match(s): continue
        if s.startswith('config '): depth += 1; stack.append(s[7:].strip())
        elif s == 'end': depth -= 1; stack.pop()
        elif s.startswith('set '):
            m = re.match(r'set (\S+)\s*(.*)', s)
            out.append((' / '.join(x for x in stack if x), m.group(1), m.group(2)))
    return out

def table_lines(tab, title):
    j = tab + 2; buf = []
    while j < len(lines):
        l = lines[j]; nxt = lines[j + 1] if j + 1 < len(lines) else ''
        if l.startswith('config ') and l != 'config ' + title:
            if nxt.startswith('Description:'): break
            if l.startswith('config firewall ') and not l.startswith('config ' + title + ' '): break
            if nxt.startswith('Parameter Description') and not l.startswith('config ' + title + ' '): 
                break
        if not NOISE.match(l.strip()) and not l.startswith('config '): buf.append(l)
        j += 1
    return buf

def starts_name(t, i, name):
    first = t[i].split(' ')[0]
    base = re.sub(r'<.*$', '', first).rstrip('*')
    if base == name: return True
    if first.endswith('-') or (base != name and name.startswith(re.sub(r'<.*$', '', first).rstrip('*')) and first.endswith('-')):
        joined = re.sub(r'<.*$', '', first)
        for d in range(1, 4):
            if i + d >= len(t): break
            joined += t[i + d].split(' ')[0]
            j = re.sub(r'<.*$', '', joined).rstrip('*')
            if j == name: return True
            if not name.startswith(re.sub(r'<.*$', '', joined)): break
    return False

MARKER_END = re.compile(r'(option - \S+|(var-)?string Maximum|string Maximum length: \d+|integer Minimum value:.*|^length: \d+|\b(user|uuid|datetime|password|mac-address|ipv4-[a-z\-]+|ipv6-[a-z\-]+)(?: Maximum.*)?)$')

def parse_toplevel(title):
    syn, tab = section_bounds(title)
    names = [(p, n, s) for p, n, s in syntax_names(syn) if p == '']
    t = table_lines(tab, title)
    entries = []; i = 0; k = 0
    def next_name(i, k, ahead=8):
        for j in range(k + 1, min(len(names), k + 1 + ahead)):
            if starts_name(t, i, names[j][1]): return j
        return None
    while k < len(names) and i < len(t):
        if not starts_name(t, i, names[k][1]):
            j = next_name(i, k - 1) if k else None
            if j is not None and j > k:
                for m in range(k, j): entries.append(dict(name=names[m][1], syntax=names[m][2], body=[], missing=True))
                k = j
                continue
            i += 1; continue
        name = names[k][1]
        start = i; state = 'post' if MARKER_END.search(t[i].strip()) else 'desc'; i += 1
        nxt = None
        while i < len(t):
            if state == 'post':
                nxt = next_name(i, k)
                if nxt is not None: break
            elif MARKER_END.search(t[i].strip()) or MARKER_END.search(' '.join(x.strip() for x in t[start:i + 1])):
                state = 'post'
            i += 1
        entries.append(dict(name=name, syntax=names[k][2], body=t[start:i]))
        if nxt is not None and nxt > k + 1:
            for m in range(k + 1, nxt): entries.append(dict(name=names[m][1], syntax=names[m][2], body=[], missing=True))
        k = nxt if nxt is not None else len(names)
    for e in entries:
        if not e.get('missing'): continue
        for i in range(len(t)):
            if starts_name(t, i, e['name']):
                j = i + 1
                while j < len(t) and j < i + 40 and not any(starts_name(t, j, n[1]) for n in names if n[1] != e['name']): j += 1
                e['body'] = t[i:j]; e.pop('missing'); break
    return entries, names

def detail(e):
    body = e['body']; text = ' '.join(x.strip() for x in body)
    d = dict(name=e['name'], syntax=e['syntax'])
    name_re = re.compile(r'^' + re.escape(e['name']).replace(r'\-', r'-\s*') + r'(\*|<[^>]*>)?\s*')
    m = re.search(r'\boption - (\S+)(?: |$)', text)
    if m:
        d['type'] = 'option'; d['default'] = m.group(1)
        k = next((i for i, l in enumerate(body) if l.strip() == 'Option Description'), None)
        opts = []
        if k is not None:
            for l in body[k + 1:]:
                mm = re.match(r'^([A-Za-z0-9_][A-Za-z0-9_\-\.]*) ([A-Z].*)$', l)
                if mm and mm.group(1) not in ('Option',): opts.append((mm.group(1), mm.group(2)))
        d['options'] = opts
        d['help'] = name_re.sub('', text.split(' option - ')[0], count=1).strip()
        return d
    m = re.search(r'\binteger Minimum value:\s*(-?\d+) Maximum\s*value:\s*(-?\d+)\s*(\S+)?', text)
    if m:
        d['type'] = 'integer'; d['min'] = int(m.group(1)); d['max'] = int(m.group(2)); d['default'] = m.group(3)
        d['help'] = name_re.sub('', text.split(' integer Minimum')[0], count=1).strip(); return d
    m = re.search(r'\b(var-string|string|password|ipv4-address-any|ipv4-address|ipv4-classnet-any|ipv4-classnet|ipv6-address|ipv6-prefix|ipv6-network|mac-address|user|uuid|datetime|date|time|integer)\b(?: Maximum.*)?$', text)
    d['type'] = m.group(1) if m else 'unknown'
    d['help'] = name_re.sub('', text[:m.start()] if m else text, count=1).strip()
    ml = re.search(r'Maximum\s*length:\s*(\d+)', text)
    if ml: d['maxlen'] = int(ml.group(1))
    return d
