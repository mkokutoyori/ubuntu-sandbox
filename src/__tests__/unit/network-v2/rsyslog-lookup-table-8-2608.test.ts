/**
 * Probe — what rsyslog 8.2608.0 added to runtime/lookup.c: the "regex" table type (rows {"regex","tag"}, first row
 * whose POSIX extended expression matches the key wins, nomatch otherwise, the glibc regcomp message when a row does
 * not compile), the uint32 range check of array and sparseArray indexes, the "is empty" message for a zero-byte
 * file and the refusal of a second lookup_table of the same name.
 *
 * Measured against the base commit (git stash of src/network): 7 of the 9 cases fall (the array / sparseArray case is
 * run for both types). The two that pass in both states are the WITNESS (a string table still answers) and the bounds
 * case, which is non-regression: 0 and 4294967295 were accepted before as well.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const MSG = (program: string): string => `<13>Oct 19 12:00:01 ubuntu ${program}: x`;
const CONFIG = (extra = ''): string => `template(name="r" type="string" string="%$!r%\\n")\nlookup_table(name="t" file="/etc/t.json")\n${extra}set $!r = lookup("t", $programname);\n*.* action(type="omfile" file="/var/log/out" template="r")\n`;

function start(content: string, config = CONFIG()): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config, { files: { '/etc/t.json': content } }) };
}

const diagnostics = (lab: ReturnType<typeof startRsyslog>): string => lab.loader.log.lines().join('\n');
const out = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/out') ?? null);
const regexTable = (rows: Array<{ regex?: string; tag?: string }>, nomatch = 'other'): string => JSON.stringify({ version: 1, type: 'regex', nomatch, table: rows });

describe('lookup tables, 8.2608.0 additions', () => {
  it('witness: a string table still answers an exact key', () => {
    const { host, lab } = start(JSON.stringify({ version: 1, table: [{ index: 'alice', value: 'A' }] }));
    submitLocal(lab, MSG('alice'));
    expect(out(host)).toEqual(['A']);
  });

  it('a regex table answers with the tag of the first row that matches, in file order, and with nomatch otherwise', () => {
    const { host, lab } = start(regexTable([{ regex: '^al', tag: 'first' }, { regex: 'ice$', tag: 'second' }, { regex: '^b[aeiou]b$', tag: 'third' }]));
    for (const program of ['alice', 'police', 'bob', 'carol']) submitLocal(lab, MSG(program));
    expect(out(host)).toEqual(['first', 'second', 'third', 'other']);
  });

  it('a regex row without "regex" or without "tag" is refused', () => {
    expect(diagnostics(start(regexTable([{ tag: 'x' }])).lab)).toContain("'regex' lookup table named: 't' has record(s) without required fields");
    expect(diagnostics(start(regexTable([{ regex: 'a' }])).lab)).toContain("'regex' lookup table named: 't' has record(s) without 'tag' field");
  });

  it('a regex that does not compile is reported with the regcomp message and the table is not built', () => {
    const { host, lab } = start(regexTable([{ regex: '(a', tag: 'x' }]));
    expect(diagnostics(lab)).toContain("error compiling regex '(a' in lookup table 't': Unmatched ( or \\(");
    submitLocal(lab, MSG('a'));
    expect(out(host)).toEqual(['']);
  });

  it.each(['array', 'sparseArray'])('a %s index below zero or above 4294967295 is refused', (type) => {
    const high = diagnostics(start(JSON.stringify({ version: 1, type, table: [{ index: 4294967296, value: 'x' }] })).lab);
    expect(high).toContain(`'${type}' lookup table name: 't' has index '4294967296' outside uint32 range`);
    const low = diagnostics(start(JSON.stringify({ version: 1, type, table: [{ index: -1, value: 'x' }] })).lab);
    expect(low).toContain(`'${type}' lookup table name: 't' has index '-1' outside uint32 range`);
  });

  it('the bounds themselves are accepted', () => {
    const { host, lab } = start(JSON.stringify({ version: 1, type: 'sparseArray', nomatch: 'n', table: [{ index: 0, value: 'low' }, { index: 4294967295, value: 'high' }] }), CONFIG().replace('$programname', '4294967295'));
    submitLocal(lab, MSG('x'));
    expect(out(host)).toEqual(['high']);
  });

  it('a zero-byte file is "empty", not a parsing error', () => {
    const text = diagnostics(start('').lab);
    expect(text).toContain("lookup table file '/etc/t.json' is empty");
    expect(text).not.toContain('json parsing error');
  });

  it('a second lookup_table with the same name is refused and the first one keeps answering', () => {
    const { host, lab } = start(JSON.stringify({ version: 1, table: [{ index: 'alice', value: 'A' }] }), CONFIG().replace('set $!r', 'lookup_table(name="t" file="/etc/other.json")\nset $!r'));
    expect(diagnostics(lab)).toContain("lookup_table: duplicate name 't' in current config set");
    submitLocal(lab, MSG('alice'));
    expect(out(host)).toEqual(['A']);
  });
});
