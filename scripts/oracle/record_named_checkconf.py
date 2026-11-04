#!/usr/bin/env python3
"""Record what the real named-checkconf (bind9utils 9.18) prints for configurations broken in one way each.

usage: record_named_checkconf.py out.json

Eighteen named.conf files, derived from the options + one primary zone of NS1-BANK of labs/dns-agence-bancaire, each with one mistake (a boolean that is not one, an unknown option, a missing
semicolon, a missing or an extra closing brace, `options` twice, an unknown zone type, a primary without file, a zone declared twice, an address with a byte of 999 in an address match list, an unknown
ACL, an unterminated string, an unknown statement, a secondary without primaries, a bad forwarder, a bad listen-on, an unterminated comment). The file is checked from its own directory under its bare
name so that the messages carry `name.conf:LINE`. Needs bind9utils.
"""
import json, os, subprocess, sys, tempfile

GOOD = '''options {
    directory "/var/cache/bind";
    recursion no;
    allow-query { any; };
};
zone "banquehorizon.com" {
    type primary;
    file "/etc/bind/db.banquehorizon.com";
    allow-transfer { 203.0.113.11; };
    notify yes;
};
'''

CASES = {
    'valid': GOOD,
    'bad-boolean': GOOD.replace('recursion no;', 'recursion nope;'),
    'unknown-option': GOOD.replace('recursion no;', 'recursionn no;'),
    'missing-semicolon': GOOD.replace('recursion no;', 'recursion no'),
    'missing-brace-eof': GOOD.rstrip('\n')[:-2],
    'extra-brace': GOOD + '};\n',
    'options-twice': GOOD + 'options { recursion yes; };\n',
    'unknown-zone-type': GOOD.replace('type primary', 'type masterr'),
    'primary-without-file': GOOD.replace('    file "/etc/bind/db.banquehorizon.com";\n', ''),
    'duplicate-zone': GOOD + 'zone "banquehorizon.com" { type primary; file "/etc/bind/db.banquehorizon.com"; };\n',
    'bad-address': GOOD.replace('203.0.113.11', '203.0.113.999'),
    'unknown-acl': GOOD.replace('allow-query { any; }', 'allow-query { agence; }'),
    'missing-quote': GOOD.replace('zone "banquehorizon.com"', 'zone "banquehorizon.com'),
    'unknown-statement': GOOD + 'foo { };\n',
    'secondary-without-primaries': GOOD + 'zone "x.test" { type secondary; file "x"; };\n',
    'forwarders-bad': GOOD.replace('recursion no;', 'recursion no; forwarders { 999.1.1.1; };'),
    'listen-on-bad': GOOD.replace('recursion no;', 'recursion no; listen-on { 10.0.0.1 };'),
    'comment-unterminated': GOOD + '/* never closed\n',
}


def main():
    out = {}
    with tempfile.TemporaryDirectory() as directory:
        for name, text in CASES.items():
            with open(os.path.join(directory, name + '.conf'), 'w') as handle:
                handle.write(text)
            result = subprocess.run(['named-checkconf', name + '.conf'], capture_output=True, text=True, cwd=directory)
            out[name] = {'conf': text, 'rc': result.returncode, 'out': (result.stdout + result.stderr).strip()}
    version = subprocess.run(['named-checkconf', '-v'], capture_output=True, text=True).stdout.strip()
    with open(sys.argv[1], 'w') as handle:
        json.dump({'named-checkconf': version, 'cases': out}, handle)
    print(len(out), 'cases')


if __name__ == '__main__':
    main()
