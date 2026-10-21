/**
 * Probe — lookup_table(), lookup() and reload_lookup_table() of rsyslog 8.2112.0, the version the machine reports
 * (runtime/lookup.c and grammar/rainerscript.c of that source: string, array and sparseArray tables, nomatch, the
 * version / type / index / value checks and their messages, the table reloaded on HUP or by reload_lookup_table()
 * on its own thread, a table stubbed when its reload fails, "TABLE-NOT-FOUND" for an unknown table). Not carried
 * over from 8.2608: regex tables, the uint32 range check, the empty-file message and the duplicate-name refusal do
 * not exist in 8.2112. json-c leniencies kept: comments, single quotes, case-insensitive literals, data after the
 * first value. Not kept: trailing commas.
 *
 * Measured against the base commit: the object was accepted and ignored, lookup() answered an unknown function and
 * reload_lookup_table() did nothing. 17 of the 20 cases fall. 3 pass in both states and say why: the witness (a
 * config without a table loads clean), "without nomatch an unknown key gives an empty string" and "a failed load
 * leaves the table empty" (the old unknown function also answered an empty string) ; the 17 others bound them.
 * Time moves with LabHost.advance(); the reload runs on the simulated clock.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const MSG = (text = 'x', program = 'alice', severity = 5): string => `<${8 + severity}>Oct 19 12:00:01 ubuntu ${program}: ${text}`;

const TEMPLATE = 'template(name="r" type="string" string="%$!r%\\n")\n';

const lookupConfig = (table: string, key: string, extra = ''): string => `${TEMPLATE}${extra}
set $!r = lookup("${table}", ${key});
*.* action(type="omfile" file="/var/log/out" template="r")
`;

const stringTable = JSON.stringify({
  version: 1, nomatch: 'unknown', type: 'string',
  table: [{ index: 'alice', value: 'Alice A.' }, { index: 'bob', value: 'Bob B.' }],
});

const start = (config: string, files: Record<string, string>): { host: LabHost; lab: ReturnType<typeof startRsyslog> } => {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config, { files }) };
};

const out = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/out') ?? null);
const diagnostics = (lab: ReturnType<typeof startRsyslog>): string => lab.loader.log.lines().join('\n');
const internal = (lab: ReturnType<typeof startRsyslog>, text: string): boolean => lab.internalMessages.some((entry) => entry.text.includes(text));

describe('lookup tables', () => {
  it('witness: a config without a table loads without a diagnostic', () => {
    const { lab } = start('*.* /var/log/x.log', {});
    expect(lab.loader.log.lines()).toEqual([]);
  });

  it('a string table answers an exact key and the nomatch value for any other', () => {
    const config = `lookup_table(name="people" file="/etc/people.json")\n${lookupConfig('people', '$programname')}`;
    const { host, lab } = start(config, { '/etc/people.json': stringTable });
    expect(diagnostics(lab)).toContain("rsyslogd: lookup table 'people' loaded from file '/etc/people.json'");
    submitLocal(lab, MSG('x', 'alice'));
    submitLocal(lab, MSG('x', 'carol'));
    expect(out(host)).toEqual(['Alice A.', 'unknown']);
  });

  it('without nomatch an unknown key gives an empty string', () => {
    const table = JSON.stringify({ version: 1, table: [{ index: 'a', value: 'A' }] });
    const { host, lab } = start(`lookup_table(name="t" file="/etc/t.json")\n${lookupConfig('t', '$programname')}`, { '/etc/t.json': table });
    submitLocal(lab, MSG('x', 'zz'));
    expect(out(host)).toEqual(['']);
  });

  it('an array table is indexed from its first key', () => {
    const table = JSON.stringify({
      version: 1, nomatch: 'none', type: 'array',
      table: [{ index: 5, value: 'notice' }, { index: 6, value: 'info' }, { index: 7, value: 'debug' }],
    });
    const { host, lab } = start(`lookup_table(name="sev" file="/etc/sev.json")\n${lookupConfig('sev', '$syslogseverity')}`, { '/etc/sev.json': table });
    for (const severity of [4, 5, 6, 7, 3]) submitLocal(lab, MSG('x', 'alice', severity));
    expect(out(host)).toEqual(['none', 'notice', 'info', 'debug', 'none']);
  });

  it('a sparse array table answers with the entry whose key is the greatest not above the one asked', () => {
    const table = JSON.stringify({
      version: 1, nomatch: 'low', type: 'sparseArray',
      table: [{ index: 0, value: 'zero' }, { index: 4, value: 'four' }, { index: 6, value: 'six' }],
    });
    const { host, lab } = start(`lookup_table(name="band" file="/etc/band.json")\n${lookupConfig('band', '$syslogseverity')}`, { '/etc/band.json': table });
    for (const severity of [0, 1, 3, 4, 5, 6, 7]) submitLocal(lab, MSG('x', 'alice', severity));
    expect(out(host)).toEqual(['zero', 'zero', 'zero', 'four', 'four', 'six', 'six']);
  });

  it('the file may carry comments, single quotes and data after the first value', () => {
    const text = "/* people */ { 'version': 1, 'table': [ { 'index': 'alice', 'value': 'A' } ] } trailing";
    const { host, lab } = start(`lookup_table(name="t" file="/etc/t.json")\n${lookupConfig('t', '$programname')}`, { '/etc/t.json': text });
    submitLocal(lab, MSG('x', 'alice'));
    expect(out(host)).toEqual(['A']);
  });
});

describe('lookup table errors', () => {
  const load = (content: string | null): string => {
    const files = content === null ? {} : { '/etc/t.json': content };
    return diagnostics(start('lookup_table(name="t" file="/etc/t.json")\n*.* /var/log/x.log', files).lab);
  };

  it('a missing file', () => {
    expect(load(null)).toContain("lookup table file '/etc/t.json' could not be opened: No such file or directory");
  });

  it('a file that is not JSON, and an empty file', () => {
    expect(load('{ nope')).toContain("lookup table file '/etc/t.json' json parsing error");
    expect(load('')).toContain("lookup table file '/etc/t.json' json parsing error");
  });

  it('a missing version is reported but the table is still built', () => {
    const text = load(JSON.stringify({ table: [{ index: 'a', value: 'A' }] }));
    expect(text).toContain("lookup table named: 't' doesn't specify version (will use default value: 1)");
    expect(text).toContain("lookup table 't' loaded from file '/etc/t.json'");
  });

  it('an unsupported version, type or table definition', () => {
    expect(load(JSON.stringify({ version: 2, table: [] }))).toContain("lookup table named: 't' uses unsupported version: 2");
    expect(load(JSON.stringify({ version: 1, type: 'regex', table: [] }))).toContain("lookup table named: 't' uses unupported type: 'regex'");
    expect(load(JSON.stringify({ version: 1, table: 'x' }))).toContain("lookup table named: 't' has invalid table definition");
  });

  it('records without a value or an index', () => {
    expect(load(JSON.stringify({ version: 1, table: [{ index: 'a' }] }))).toContain("'string' lookup table named: 't' has record(s) without 'value' field");
    expect(load(JSON.stringify({ version: 1, type: 'array', table: [{ value: 'a' }] }))).toContain("'array' lookup table named: 't' has record(s) without 'index' field");
  });

  it('an array table with a hole names the incremented previous index, as lookup.c does', () => {
    const table = JSON.stringify({ version: 1, type: 'array', table: [{ index: 1, value: 'a' }, { index: 3, value: 'c' }] });
    expect(load(table)).toContain("'array' lookup table name: 't' has non-contiguous members between index '2' and '3'");
  });

  it('lookup() of a table defined later or never is refused and answers TABLE-NOT-FOUND', () => {
    const config = `${lookupConfig('late', '$programname')}lookup_table(name="late" file="/etc/t.json")`;
    const { host, lab } = start(config, { '/etc/t.json': stringTable });
    expect(diagnostics(lab)).toContain("lookup table 'late' not found (used in function: lookup)");
    submitLocal(lab, MSG('x', 'alice'));
    expect(out(host)).toEqual(['TABLE-NOT-FOUND']);
  });

  it('the first argument of lookup() must be a constant string', () => {
    const config = `lookup_table(name="t" file="/etc/t.json")\n${lookupConfig('t', '$programname').replace('lookup("t"', 'lookup($programname')}`;
    expect(diagnostics(start(config, { '/etc/t.json': stringTable }).lab)).toContain('table name (param 1) of lookup() must be a constant string');
  });

  it('a failed load leaves the table registered and empty: lookup() answers an empty string', () => {
    const { host, lab } = start(`lookup_table(name="t" file="/etc/none.json")\n${lookupConfig('t', '$programname')}`, {});
    submitLocal(lab, MSG('x', 'alice'));
    expect(out(host)).toEqual(['']);
  });
});

describe('reloading', () => {
  const config = `lookup_table(name="people" file="/etc/people.json")\n${lookupConfig('people', '$programname')}`;
  const changed = JSON.stringify({ version: 1, nomatch: 'unknown', table: [{ index: 'alice', value: 'Alice, changed' }] });

  it('HUP reloads the table from its file on the simulated clock, after the request returns', () => {
    const { host, lab } = start(config, { '/etc/people.json': stringTable });
    host.fileSystem.set('/etc/people.json', changed);
    lab.engine.hup();
    submitLocal(lab, MSG('x', 'alice'));
    host.advance(1);
    submitLocal(lab, MSG('x', 'alice'));
    expect(out(host)).toEqual(['Alice A.', 'Alice, changed']);
    expect(internal(lab, "lookup table 'people' reloaded from file '/etc/people.json'")).toBe(true);
  });

  it('reloadOnHUP="off" keeps the table across a HUP', () => {
    const { host, lab } = start(config.replace('file="/etc/people.json"', 'file="/etc/people.json" reloadOnHUP="off"'), { '/etc/people.json': stringTable });
    host.fileSystem.set('/etc/people.json', changed);
    lab.engine.hup();
    host.advance(1);
    submitLocal(lab, MSG('x', 'alice'));
    expect(out(host)).toEqual(['Alice A.']);
  });

  it('a failed reload keeps the previous table and says so', () => {
    const { host, lab } = start(config, { '/etc/people.json': stringTable });
    host.fileSystem.set('/etc/people.json', '{ broken');
    lab.engine.hup();
    host.advance(1);
    submitLocal(lab, MSG('x', 'alice'));
    expect(out(host)).toEqual(['Alice A.']);
    expect(internal(lab, "lookup table file '/etc/people.json' json parsing error")).toBe(true);
    expect(internal(lab, "lookup table 'people' could not be reloaded from file '/etc/people.json'")).toBe(true);
  });

  it('reload_lookup_table() reloads when the statement runs, and a stub replaces a table whose reload fails', () => {
    const rules = `${config}\nif $msg contains "reload" then reload_lookup_table("people", "stubbed")\n`;
    const { host, lab } = start(rules, { '/etc/people.json': stringTable });
    host.fileSystem.set('/etc/people.json', changed);
    submitLocal(lab, MSG('reload', 'alice'));
    host.advance(1);
    submitLocal(lab, MSG('x', 'alice'));
    expect(out(host)[out(host).length - 1]).toBe('Alice, changed');
    host.fileSystem.set('/etc/people.json', '{ broken');
    submitLocal(lab, MSG('reload', 'alice'));
    host.advance(1);
    submitLocal(lab, MSG('x', 'anyone'));
    expect(out(host)[out(host).length - 1]).toBe('stubbed');
    expect(internal(lab, "stubbing lookup table 'people' with value 'stubbed'")).toBe(true);
    expect(internal(lab, "lookup table 'people' stubbed with value 'stubbed'")).toBe(true);
  });

  it('refuses a statement with the wrong arguments, or for a table that does not exist', () => {
    const base = 'lookup_table(name="t" file="/etc/t.json")\n*.* /var/log/x.log\n';
    const usage = 'statement ignored: reload_lookup_table(table_name, optional:stub_value_in_case_reload_fails) ';
    const run = (statement: string): string => diagnostics(start(`${base}${statement}`, { '/etc/t.json': stringTable }).lab);
    expect(run('reload_lookup_table("t", "a", "b")')).toContain(`${usage}expected 1 or 2 arguments, but found '3'`);
    expect(run('reload_lookup_table()')).toContain(`${usage}expected 1 or 2 arguments, but found '0'`);
    expect(run('reload_lookup_table("missing")')).toContain("lookup table 'missing' not found");
  });
});
