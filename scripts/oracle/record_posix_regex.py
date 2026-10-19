#!/usr/bin/env python3
"""Record glibc regcomp / regexec answers for POSIX extended regular expressions.

usage: record_posix_regex.py [--seed N] [--cases N] [--mode raw|valid] out.json

Each case is a pattern, a text, a start offset (REG_STARTEND, in bytes) and the REG_ICASE flag; the answer is either the
regerror text or the span of the match and of its first nine groups, in bytes.  The C helper is compiled on the fly.
"""
import argparse, json, os, random, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

RAW_ATOMS = ['a', 'b', 'c', '.', 'x', 'é', '\\.', '\\w', '\\W', '\\s', '\\S', '[abc]', '[^a]', '[a-c]', '[[:alpha:]]', '[[:digit:]]', '[]a]', '[a-]',
             '\\<', '\\>', '\\b', '\\B', '^', '$', '(a)', '(ab|c)', '\\1', '\\2', ' ', '1', '2', '-', '(', ')', '[', ']', '{', '}', '*', '+', '?', '|',
             '\\', '{2}', '{1,2}', '{,2}', '{2,}', '{1', '{x}', '\\(', '\\|', '[[.a.]]', '[[=a=]]', '[[:foo:]]', '[z-a]', '[a-c-e]', 'Z', 'A',
             '[[:upper:]]', '[[:lower:]]']
VALID_ATOMS = ['a', 'b', 'c', 'ab', '.', 'x', 'é', '\\.', '\\w', '\\W', '\\s', '[abc]', '[^a]', '[a-c]', '[[:alpha:]]', '[[:digit:]]', '\\<', '\\>',
               '\\b', '^', '$', '(a)', '(ab|c)', '(a*)', '(b|bc)', '\\1', ' ', '1', '*', '+', '?', '|', '{2}', '{1,2}', '{,2}', '{2,}', '(', ')',
               'a*', 'b+', 'c?', '(a|ab)(c|bcd)?', '(.)\\1', '[[:upper:]]', '[[:lower:]]']
TEXTS = ['abc', 'aab', 'a b', 'é1x', 'abcabc', '  a.b  ', 'ab(c)', 'aaaa', '', 'xyz abc', 'a1b2c3', 'Hello World', 'AB ab', 'a-b', 'a]b']


def hexed(text):
    return text.encode().hex() if text else '-'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--cases', type=int, default=3000)
    ap.add_argument('--mode', choices=['raw', 'valid'], default='raw')
    ap.add_argument('out')
    a = ap.parse_args()
    r = random.Random(a.seed)
    atoms = RAW_ATOMS if a.mode == 'raw' else VALID_ATOMS
    cases = []
    while len(cases) < a.cases:
        pattern = ''.join(r.choice(atoms) for _ in range(r.randint(1, 6) if a.mode == 'raw' else r.randint(2, 7)))
        text = r.choice(TEXTS)
        start = r.choice([0, 0, 0, 1, 2])
        if start > len(text.encode()) or (start > 0 and text.startswith('é') and start == 1):
            start = 0
        cases.append({'flags': r.choice(['', '', 'i']), 'pattern': pattern, 'text': text, 'start': start})
    with tempfile.TemporaryDirectory() as work:
        binary = os.path.join(work, 'oracle')
        subprocess.run(['gcc', '-O1', '-o', binary, os.path.join(HERE, 'posix_regex_oracle.c')], check=True)
        feed = ''.join('%s %s %s %d\n' % (c['flags'] or '-', hexed(c['pattern']), hexed(c['text']), c['start']) for c in cases)
        answers = subprocess.run([binary], input=feed, capture_output=True, text=True, check=True).stdout.strip().split('\n')
    assert len(answers) == len(cases)
    for case, answer in zip(cases, answers):
        case['want'] = answer
    json.dump({'glibc': subprocess.run(['ldd', '--version'], capture_output=True, text=True).stdout.split('\n')[0], 'mode': a.mode, 'seed': a.seed, 'cases': cases}, open(a.out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('%d cases -> %s' % (len(cases), a.out))


if __name__ == '__main__':
    main()
