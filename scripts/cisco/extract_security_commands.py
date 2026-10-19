import glob
import json
import os
import re
import sys

import pypdf

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
BOOKS = os.path.join(ROOT, 'official_docs', 'cisco', 'ios-security')
OUT = os.path.join(BOOKS, 'commands-index.json')


def page_texts(path):
    reader = pypdf.PdfReader(path)
    return [(index + 1, page.extract_text() or '') for index, page in enumerate(reader.pages)]


def contents_names(pages):
    names = set()
    for number, text in pages:
        if number > 40:
            break
        for line in text.split('\n'):
            match = re.match(r'^(.*?[A-Za-z\)])\s?(\d+)$', line)
            if match and 'CHAPTER' not in line and 'Cisco IOS' not in line:
                names.add(match.group(1).replace(' ', ''))
    return names


def entries_of(book, pages):
    names = contents_names(pages)
    seen = set()
    entries = []
    for number, text in pages:
        lines = text.split('\n')
        for index, line in enumerate(lines):
            key = line.replace(' ', '')
            if key not in names or len(line) <= 2 or index + 1 >= len(lines) or (key, number) in seen:
                continue
            window = '\n'.join(lines[index + 1:index + 40])
            if not any(marker in window for marker in ('Command Modes', 'Command Default', 'Syntax Description')):
                continue
            seen.add((key, number))
            syntax = []
            for follower in lines[index + 1:index + 30]:
                if re.match(r'(Syntax Description|Command Default|Command Modes)', follower):
                    break
                if follower.startswith(line.split(' ')[0]) and not follower.startswith('no '):
                    syntax.append(follower)
            mode = None
            for position in range(index + 1, min(index + 80, len(lines))):
                if lines[position].startswith('Command Modes'):
                    mode = ' '.join(lines[position + 1:position + 3])
                    break
            entries.append({'book': book, 'page': number, 'name': line, 'syntax': syntax[:3], 'mode': mode})
    return entries


def main():
    entries = []
    for path in sorted(glob.glob(os.path.join(BOOKS, '*.pdf'))):
        book = os.path.basename(path).replace('ios-security-command-reference-', '').replace('.pdf', '')
        entries.extend(entries_of(book, page_texts(path)))
    with open(OUT, 'w') as handle:
        json.dump(entries, handle, indent=0)
    print(len(entries), 'commands ->', OUT)


if __name__ == '__main__':
    sys.exit(main())
