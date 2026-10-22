import os, re, subprocess, sys, json, tempfile

LAB = '/tmp/syscall-trace-lab'
PROGRAMS = {
    'cat': {'operands': 'files', 'exe': '/usr/bin/cat'},
    'ls': {'operands': 'single-dir', 'exe': '/usr/bin/ls'},
    'stat': {'operands': 'single-file', 'exe': '/usr/bin/stat'},
    'head': {'operands': 'single-file', 'exe': '/usr/bin/head'},
    'tail': {'operands': 'single-file', 'exe': '/usr/bin/tail'},
    'wc': {'operands': 'single-file', 'exe': '/usr/bin/wc'},
    'md5sum': {'operands': 'single-file', 'exe': '/usr/bin/md5sum'},
    'sha256sum': {'operands': 'single-file', 'exe': '/usr/bin/sha256sum'},
    'whoami': {'operands': 'none', 'exe': '/usr/bin/whoami'},
    'hostname': {'operands': 'none', 'exe': '/usr/bin/hostname'},
    'uname': {'operands': 'none', 'exe': '/usr/bin/uname'},
}
LINE = re.compile(r'^(\w+)\((.*)\)\s+=\s+(\?|-?\d+|0x[0-9a-f]+)(?:\s+([A-Z0-9_]+)\s+\(.*\))?(?:\s+<.*>)?$')


def prepare():
    os.makedirs(LAB + '/d1', exist_ok=True)
    os.makedirs(LAB + '/d2', exist_ok=True)
    open(LAB + '/f1', 'w').write('alpha')
    open(LAB + '/f2', 'w').write('beta-two')
    for d in ('d1', 'd2'):
        for n in ('a', 'b'):
            open(f'{LAB}/{d}/{n}', 'w').close()


def split_args(text):
    out, depth, quote, cur, i = [], 0, False, '', 0
    while i < len(text):
        c = text[i]
        if quote:
            cur += c
            if c == '\\':
                cur += text[i + 1]
                i += 1
            elif c == '"':
                quote = False
        elif c == '"':
            quote = True
            cur += c
        elif c in '{[(':
            depth += 1
            cur += c
        elif c in '}])':
            depth -= 1
            cur += c
        elif c == ',' and depth == 0:
            out.append(cur.strip())
            cur = ''
        else:
            cur += c
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out


def run(program, operands):
    spec = PROGRAMS[program]
    with tempfile.NamedTemporaryFile(delete=False) as f:
        out = f.name
    subprocess.run(['strace', '-X', 'raw', '-o', out, spec['exe'], *operands], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=LAB, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    calls = []
    for raw in open(out):
        raw = raw.rstrip('\n')
        if raw.startswith('+++') or raw.startswith('---'):
            continue
        m = LINE.match(raw)
        if not m:
            raise SystemExit(f'cannot parse: {raw}')
        name, args, ret, errno = m.group(1), split_args(m.group(2)), m.group(3), m.group(4)
        calls.append({'name': name, 'args': args, 'ret': None if ret == '?' else int(ret, 0), 'errno': errno})
    os.unlink(out)
    return calls


def tokenised(calls, operands):
    marked = []
    for call in calls:
        args = []
        for arg in call['args']:
            token = arg
            for index, operand in enumerate(operands):
                if arg == f'"{operand}"':
                    token = f'$op{index}'
            args.append(token)
        marked.append({**call, 'args': args})
    return marked


def key(call):
    return (call['name'], tuple(a if a.startswith('$op') else ('v' if re.match(r'^-?(0x)?[0-9a-f]+$', a) else a[:0]) for a in call['args']))


def align(one, two):
    p = 0
    while p < len(one) and not any(a.startswith('$op') for a in one[p]['args']):
        p += 1
    return p


def build(program):
    spec = PROGRAMS[program]
    if spec['operands'] == 'none':
        calls = run(program, [])
        return {'prologue': calls, 'operandBlock': [], 'epilogue': []}
    if spec['operands'] in ('single-dir', 'single-file'):
        operands = [f'{LAB}/d1' if spec['operands'] == 'single-dir' else f'{LAB}/f1']
        calls = tokenised(run(program, operands), operands)
        return {'prologue': calls, 'operandBlock': [], 'epilogue': [], 'singleOperand': True, 'operandKind': 'directory' if spec['operands'] == 'single-dir' else 'file'}
    kind = 'f'
    ops1 = [f'{LAB}/{kind}1']
    ops2 = [f'{LAB}/{kind}1', f'{LAB}/{kind}2']
    one = tokenised(run(program, ops1), ops1)
    two = tokenised(run(program, ops2), ops2)
    p = align(one, two)
    size = len(two) - len(one)
    tail = len(one) - p - size
    if size <= 0 or tail < 0:
        raise SystemExit(f'{program}: inconsistent traces {len(one)} / {len(two)}')
    block1 = one[p:p + size]
    for left, right in zip(block1, two[p:p + size]):
        if key(left) != key(right):
            raise SystemExit(f'{program}: first block differs: {left} {right}')
    for left, right in zip(one[p + size:], two[p + 2 * size:]):
        if key(left) != key(right):
            raise SystemExit(f'{program}: epilogue differs: {left} {right}')
    return {'prologue': one[:p], 'operandBlock': block1, 'epilogue': one[p + size:]}


PATH_ARGUMENT = {'openat': 1, 'access': 0, 'statx': 1, 'newfstatat': 1, 'statfs': 0, 'readlink': 0, 'readlinkat': 1}


def slim(call, index, arg):
    if arg.startswith('"'):
        return arg if PATH_ARGUMENT.get(call['name']) == index else '"_"'
    if arg.startswith('{') or arg.startswith('['):
        return '{}'
    if '/*' in arg:
        return arg.split(' ')[0]
    return arg.lstrip('|')


def render(call):
    return [call['name'], [slim(call, i, a) for i, a in enumerate(call['args'][:4])], call['ret'], call['errno']]


def main():
    prepare()
    result = {}
    for program in PROGRAMS:
        built = build(program)
        result[program] = {k: ([render(c) for c in v if c['name'] not in ('execve', 'exit_group')] if isinstance(v, list) else v) for k, v in built.items() if not (isinstance(v, list) and len(v) == 0)}
        print(program, {k: len(v) for k, v in result[program].items() if isinstance(v, list)}, file=sys.stderr)
    body = json.dumps(result, separators=(',', ':'))
    with open(sys.argv[1], 'w') as out:
        out.write("import type { ProgramTrace } from '../ProgramTraceReplay';\n\n")
        out.write('export const PROGRAM_TRACES: Readonly<Record<string, ProgramTrace>> = ' + body + ';\n')


main()
