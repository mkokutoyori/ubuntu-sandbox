import { describe, expect, it } from 'vitest';
import { RsyslogMessage, type JsonValue } from '@/network/rsyslog/Message';
import { defaultParserChain, parseReceivedMessage } from '@/network/rsyslog/MessageParser';
import type { RenderContext } from '@/network/rsyslog/Properties';
import {
  TemplateError, parseLegacyTemplate, parseStringTemplate, renderTemplate, renderTemplateJson, standardTemplates, templateFromObject,
  type TemplateObject, type TemplateParamValue,
} from '@/network/rsyslog/Template';
import { syslogTimeFromEpochMs } from '@/network/syslog/codec/SyslogTime';

const RECEIVED_AT_MS = Date.UTC(2003, 7, 24, 12, 30, 0);

function context(nowMs = RECEIVED_AT_MS, globals: { [key: string]: JsonValue } = {}): RenderContext {
  return {
    now: () => syslogTimeFromEpochMs(nowMs, 0),
    nowUtc: () => syslogTimeFromEpochMs(nowMs, 0),
    localHostName: () => 'sandbox',
    uptimeSeconds: () => 42,
    globalVariables: globals,
  };
}

function inject(raw: string, variables: { [key: string]: JsonValue } = {}): RsyslogMessage {
  const message = new RsyslogMessage({
    rawMsg: raw, receivedAt: syslogTimeFromEpochMs(RECEIVED_AT_MS, 0), inputName: 'imuxsock', fromHost: 'sandbox',
    fromHostIp: '127.0.0.1', fromHostPort: null, localHostName: 'sandbox',
  });
  parseReceivedMessage(message, defaultParserChain());
  message.cee = { ...variables };
  return message;
}

type Params = Record<string, TemplateParamValue>;

function list(name: string, entries: Array<['constant' | 'property', Params]>, extra: Params = {}): TemplateObject {
  return { params: { name, type: 'list', ...extra }, entries: entries.map(([kind, params]) => ({ kind, params })) };
}

const constant = (value: string, extra: Params = {}): ['constant', Params] => ['constant', { value, ...extra }];
const property = (name: string, extra: Params = {}): ['property', Params] => ['property', { name, ...extra }];

function renderList(entries: Array<['constant' | 'property', Params]>, message: RsyslogMessage, extra: Params = {}): string {
  return renderTemplate(templateFromObject(list('t', entries, extra)), message, context());
}

describe('rsyslog templates — tests/template-property-transformations.sh', () => {
  const variables: { [key: string]: JsonValue } = {
    fields: 'one,two,,four,', word: 'alphabet', short: 'xy', regexsrc: 'abc-123 def-456 ghi-789', optional: 'abc',
    mixed: 'MiXeD', spaces: 'a   b  c', line: 'tail\n', leading: ' lead', control: 'a\nb\tc', path: 'a/b/c', empty: '',
    dot: '.', dotdot: '..', csvsrc: 'a,"b"', jsonsrc: 'a \\ "b"', jsonrsrc: 'a \\n b', zero: 0, auto: 42, false: 0,
  };
  const trigger = inject('<167>1 2003-08-24T05:14:15.000003-07:00 host/name app proc msgid - trigger/path  a  b', variables);

  const outformat = list('outfmt', [
    constant('field2='), property('$!fields', { 'field.number': 2, 'field.delimiter': 44 }),
    constant('\nfield_empty=<'), property('$!fields', { 'field.number': 3, 'field.delimiter': 44 }),
    constant('>\nfield_final=<'), property('$!fields', { 'field.number': 5, 'field.delimiter': 44 }),
    constant('>'),
    constant('\nfield_missing='), property('$!fields', { 'field.number': 6, 'field.delimiter': 44 }),
    constant('\nsubstr='), property('$!word', { 'position.from': 2, 'position.to': 4 }),
    constant('\nsubstr_neg_to='), property('$!word', { 'position.from': 2, 'position.to': -2 }),
    constant('\nsubstr_neg_underflow='), property('$!word', { 'position.from': 1, 'position.to': -99 }),
    constant('\nsubstr_beyond='), property('$!word', { 'position.from': 99, 'position.to': 120 }),
    constant('\nsubstr_superset='), property('$!word', { 'position.from': 1, 'position.to': 999 }),
    constant('\nrelend='), property('$!word', { 'position.from': 3, 'position.to': 1, 'position.relativetoend': 'on' }),
    constant('\nrelend_underflow='), property('$!short', { 'position.from': 99, 'position.to': 50, 'position.relativetoend': 'on' }),
    constant('\nfixed='), property('$!short', { 'position.from': 1, 'position.to': 5, fixedwidth: 'on' }),
    constant('|\nregex_second='),
    property('$!regexsrc', { 'regex.expression': '([a-z]+)-([0-9]+)', 'regex.type': 'ERE', 'regex.match': 1, 'regex.submatch': 2 }),
    constant('\nregex_third='),
    property('$!regexsrc', { 'regex.expression': '([a-z]+)-([0-9]+)', 'regex.type': 'ERE', 'regex.match': 2, 'regex.submatch': 2 }),
    constant('\nregex_optional_blank=<'),
    property('$!optional', { 'regex.expression': '([a-z]+)(-([0-9]+))?', 'regex.type': 'ERE', 'regex.submatch': 3, 'regex.nomatchmode': 'BLANK' }),
    constant('>'),
    constant('\nregex_default='), property('$!word', { 'regex.expression': 'ZZZ', 'regex.type': 'ERE', 'regex.nomatchmode': 'DFLT' }),
    constant('\nregex_blank=<'), property('$!word', { 'regex.expression': 'ZZZ', 'regex.type': 'ERE', 'regex.nomatchmode': 'BLANK' }),
    constant('>'),
    constant('\nregex_field='), property('$!word', { 'regex.expression': 'ZZZ', 'regex.type': 'ERE', 'regex.nomatchmode': 'FIELD' }),
    constant('\nregex_zero='), property('$!word', { 'regex.expression': 'ZZZ', 'regex.type': 'ERE', 'regex.nomatchmode': 'ZERO' }),
    constant('\nupper='), property('$!mixed', { caseconversion: 'upper' }),
    constant('\nlower='), property('$!mixed', { caseconversion: 'lower' }),
    constant('\ncompress='), property('$!spaces', { compressspace: 'on' }),
    constant('\ncompress_msg='), property('msg', { compressspace: 'on' }),
    constant('\ndroplastlf='), property('$!line', { droplastlf: 'on' }),
    constant('\nspif_nonspace=<'), property('$!word', { spifno1stsp: 'on' }),
    constant('>'),
    constant('\nspif_space=<'), property('$!leading', { spifno1stsp: 'on' }),
    constant('>'),
    constant('\ncc_drop='), property('$!control', { controlcharacters: 'drop' }),
    constant('\ncc_space='), property('$!control', { controlcharacters: 'space' }),
    constant('\ncc_escape='), property('$!control', { controlcharacters: 'escape' }),
    constant('\ncc_escape_octal='), property('$!control', { controlcharacters: 'escape-octal' }),
    constant('\nsec_drop='), property('$!path', { securepath: 'drop' }),
    constant('\nsec_replace='), property('$!path', { securepath: 'replace' }),
    constant('\nsec_replace_msg='), property('msg', { securepath: 'replace' }),
    constant('\nsec_empty='), property('$!empty', { securepath: 'drop' }),
    constant('\nsec_dot='), property('$!dot', { securepath: 'drop' }),
    constant('\nsec_dotdot='), property('$!dotdot', { securepath: 'drop' }),
    constant('\ncsv='), property('$!csvsrc', { format: 'csv' }),
    constant('\ncombo_msg='), property('msg', { securepath: 'replace', compressspace: 'on', format: 'csv' }),
    constant('\njson='), property('$!jsonsrc', { format: 'json' }),
    constant('\njsonf='), property('$!jsonsrc', { outname: 'jsonsrc', format: 'jsonf' }),
    constant('\njsonr='), property('$!jsonrsrc', { format: 'jsonr' }),
    constant('\njsonfr='), property('$!jsonrsrc', { outname: 'jsonrsrc', format: 'jsonfr' }),
    constant('\njson_zero=<'), property('$!zero', { outname: 'zero', format: 'jsonf', datatype: 'number', omitIfZero: 'on' }),
    constant('>\njson_empty=<'), property('$!empty', { outname: 'empty', format: 'jsonf', onEmpty: 'skip' }),
    constant('>\njson_auto=<'), property('$!auto', { outname: 'auto', format: 'jsonf', datatype: 'auto' }),
    constant('>\njson_false=<'), property('$!false', { outname: 'false', format: 'jsonf', datatype: 'bool' }),
    constant('>'),
    constant('\nmsg='), property('msg'),
    constant('\nhostname='), property('hostname'),
    constant('\nsyslogtag='), property('syslogtag'),
    constant('\nrawmsg_after_pri='), property('rawmsg-after-pri'),
    constant('\npri='), property('pri'),
    constant('\npri_text='), property('pri-text'),
    constant('\niut='), property('iut'),
    constant('\nfacility='), property('syslogfacility'),
    constant('\nfacility_text='), property('syslogfacility-text'),
    constant('\nseverity='), property('syslogseverity'),
    constant('\nseverity_text='), property('syslogseverity-text'),
    constant('\nprogramname='), property('programname'),
    constant('\nprotocol='), property('protocol-version'),
    constant('\nstructured_data='), property('structured-data'),
    constant('\napp_name='), property('app-name'),
    constant('\nprocid='), property('procid'),
    constant('\nmsgid='), property('msgid'),
    constant('\nparsesuccess='), property('parsesuccess'),
    constant('\nreported_utc='), property('timereported', { dateformat: 'rfc3339', 'date.inUTC': 'on' }),
    constant('\nreported_local_mysql='), property('timereported', { dateformat: 'mysql' }),
    constant('\nreported_local_pgsql='), property('timereported', { dateformat: 'pgsql' }),
    constant('\nreported_local_rfc3164='), property('timereported', { dateformat: 'rfc3164' }),
    constant('\nreported_local_rfc3164_buggy='), property('timereported', { dateformat: 'rfc3164-buggyday' }),
    constant('\nreported_local_unix='), property('timereported', { dateformat: 'unixtimestamp' }),
    constant('\nreported_local_subseconds='), property('timereported', { dateformat: 'subseconds' }),
    constant('\nreported_local_misc='), property('timereported', { dateformat: 'wdayname' }),
    constant('/'), property('timereported', { dateformat: 'wday' }),
    constant('/'), property('timereported', { dateformat: 'tzoffshour' }),
    constant(':'), property('timereported', { dateformat: 'tzoffsmin' }),
    constant('/'), property('timereported', { dateformat: 'tzoffsdirection' }),
    constant('/'), property('timereported', { dateformat: 'ordinal' }),
    constant('/'), property('timereported', { dateformat: 'week' }),
    constant('\nreported_utc_formats='), property('timereported', { dateformat: 'mysql', 'date.inUTC': 'on' }),
    constant('/'), property('timereported', { dateformat: 'pgsql', 'date.inUTC': 'on' }),
    constant('/'), property('timereported', { dateformat: 'rfc3164', 'date.inUTC': 'on' }),
    constant('/'), property('timereported', { dateformat: 'unixtimestamp', 'date.inUTC': 'on' }),
    constant('/'), property('timereported', { dateformat: 'subseconds', 'date.inUTC': 'on' }),
    constant('\nreported_parts='), property('timereported', { dateformat: 'year', 'date.inUTC': 'on' }),
    constant('-'), property('timereported', { dateformat: 'month', 'date.inUTC': 'on' }),
    constant('-'), property('timereported', { dateformat: 'day', 'date.inUTC': 'on' }),
    constant('T'), property('timereported', { dateformat: 'hour', 'date.inUTC': 'on' }),
    constant(':'), property('timereported', { dateformat: 'minute', 'date.inUTC': 'on' }),
    constant(':'), property('timereported', { dateformat: 'second', 'date.inUTC': 'on' }),
    constant('\n'),
  ]);

  const legacyText =
    'legacy_upper=%$!mixed:::uppercase%\nlegacy_fixed=%$!short:1:5:fixed-width%|\nlegacy_relend=%$!word:3:1:pos-end-relative%\n' +
    'legacy_swap=%$!word:4:2%\nlegacy_field=%$!fields:F,44:2%\nlegacy_escape=%$!control:::escape-cc%\n' +
    'legacy_sec_replace=%$!path:::secpath-replace%\nlegacy_jsonf=%$!jsonsrc:::jsonf%\nlegacy_jsonr=%$!jsonrsrc:::jsonr%\n' +
    'legacy_jsonfr=%$!jsonrsrc:::jsonfr%\nlegacy_date=%timereported:::date-wdayname%/%timereported:::date-week%\n';

  const expected = `field2=two
field_empty=<>
field_final=<>
field_missing=**FIELD NOT FOUND**
substr=lph
substr_neg_to=lphab
substr_neg_underflow=a
substr_beyond=
substr_superset=alphabet
relend=bet
relend_underflow=x
fixed=xy   |
regex_second=456
regex_third=789
regex_optional_blank=<>
regex_default=**NO MATCH**
regex_blank=<>
regex_field=alphabet
regex_zero=0
upper=MIXED
lower=mixed
compress=a b c
compress_msg=trigger/path a b
droplastlf=tail
spif_nonspace=< >
spif_space=<>
cc_drop=abc
cc_space=a b c
cc_escape=a#010b#009c
cc_escape_octal=a#012b#011c
sec_drop=abc
sec_replace=a_b_c
sec_replace_msg=trigger_path  a  b
sec_empty=_
sec_dot=_
sec_dotdot=_.
csv="a,""b"""
combo_msg="trigger_path a b"
json=a \\\\ \\"b\\"
jsonf="jsonsrc":"a \\\\ \\"b\\""
jsonr=a \\n b
jsonfr="jsonrsrc":"a \\n b"
json_zero=<>
json_empty=<>
json_auto=<"auto":42>
json_false=<"false":false>
msg=trigger/path  a  b
hostname=host/name
syslogtag=app[proc]
rawmsg_after_pri=1 2003-08-24T05:14:15.000003-07:00 host/name app proc msgid - trigger/path  a  b
pri=167
pri_text=local4.debug
iut=1
facility=20
facility_text=local4
severity=7
severity_text=debug
programname=app
protocol=1
structured_data=-
app_name=app
procid=proc
msgid=msgid
parsesuccess=FAIL
reported_utc=2003-08-24T12:14:15.000003+00:00
reported_local_mysql=20030824051415
reported_local_pgsql=2003-08-24 05:14:15
reported_local_rfc3164=Aug 24 05:14:15
reported_local_rfc3164_buggy=Aug 24 05:14:15
reported_local_unix=1061727255
reported_local_subseconds=000003
reported_local_misc=Sun/0/07:00/-/236/35
reported_utc_formats=20030824121415/2003-08-24 12:14:15/Aug 24 12:14:15/1061727255/000003
reported_parts=2003-08-24T12:14:15
legacy_upper=MIXED
legacy_fixed=xy   |
legacy_relend=bet
legacy_swap=lph
legacy_field=two
legacy_escape=a#010b#009c
legacy_sec_replace=a_b_c
legacy_jsonf="jsonsrc":"a \\\\ \\"b\\""
legacy_jsonr=a \\n b
legacy_jsonfr="jsonrsrc":"a \\n b"
legacy_date=Sun/35`.split('\n').sort();

  it('renders the 90-line reference output of the C testbench, line for line', () => {
    const lines = [
      ...renderTemplate(templateFromObject(outformat), trigger, context()).split('\n'),
      ...renderTemplate(parseStringTemplate('legacyfmt', legacyText), trigger, context()).split('\n'),
    ].filter((line) => line.length > 0).sort();
    expect(lines).toEqual(expected);
  });

  it('renders the three message shapes of the reference testbench', () => {
    const shape = list('shapefmt', [
      constant('shape_msg='), property('msg'), constant('\nshape_hostname='), property('hostname'),
      constant('\nshape_syslogtag='), property('syslogtag'), constant('\nshape_programname='), property('programname'),
      constant('\nshape_protocol='), property('protocol-version'), constant('\nshape_structured_data='), property('structured-data'),
      constant('\nshape_app_name='), property('app-name'), constant('\nshape_procid='), property('procid'),
      constant('\nshape_msgid='), property('msgid'), constant('\nshape_rawmsg_after_pri='), property('rawmsg-after-pri'),
    ]);
    const template = templateFromObject(shape);
    const render = (raw: string) => renderTemplate(template, inject(raw), context());
    expect(render('<167>Aug 24 05:14:15 legacyhost legacyprog[42]: shape3164')).toBe(
      'shape_msg= shape3164\nshape_hostname=legacyhost\nshape_syslogtag=legacyprog[42]:\nshape_programname=legacyprog\nshape_protocol=0\n' +
      'shape_structured_data=-\nshape_app_name=legacyprog\nshape_procid=42\nshape_msgid=-\n' +
      'shape_rawmsg_after_pri=Aug 24 05:14:15 legacyhost legacyprog[42]: shape3164',
    );
    expect(render('<167>1 2003-08-24T05:14:15.000003-07:00 nilhost - - - - shape5424nil')).toBe(
      'shape_msg=shape5424nil\nshape_hostname=nilhost\nshape_syslogtag=-\nshape_programname=-\nshape_protocol=1\n' +
      'shape_structured_data=-\nshape_app_name=-\nshape_procid=-\nshape_msgid=-\n' +
      'shape_rawmsg_after_pri=1 2003-08-24T05:14:15.000003-07:00 nilhost - - - - shape5424nil',
    );
    expect(render('<167>Aug 24 05:14:15 oddhost shape3164notag')).toBe(
      'shape_msg=\nshape_hostname=oddhost\nshape_syslogtag=shape3164notag\nshape_programname=shape3164notag\nshape_protocol=0\n' +
      'shape_structured_data=-\nshape_app_name=shape3164notag\nshape_procid=-\nshape_msgid=-\n' +
      'shape_rawmsg_after_pri=Aug 24 05:14:15 oddhost shape3164notag',
    );
  });
});

describe('rsyslog templates — position and escaping testbench', () => {
  const tcpfloodMessage = () => inject('<167>Mar  1 01:00:00 172.20.245.8 tag msgnum:00000000:');

  it('template-pos-from-to.sh: %msg:9:16:% extracts the counter', () => {
    expect(renderTemplate(parseStringTemplate('outfmt', '%msg:9:16:%\n'), tcpfloodMessage(), context())).toBe('00000000\n');
  });

  it('template-pos-from-to-oversize.sh: a window beyond the message is empty in string and list templates', () => {
    expect(renderTemplate(parseStringTemplate('outfmt', '-%msg:109:116:%-\n'), tcpfloodMessage(), context())).toBe('--\n');
    expect(renderList([constant('-'), property('msg', { 'position.from': 109, 'position.to': 116 }), constant('-'), constant('\n')], tcpfloodMessage())).toBe('--\n');
  });

  it('template-topos-neg.sh: a negative position.to counts from the end', () => {
    const message = inject('<167>1 2003-08-24T05:14:15.000003-07:00 host app proc msgid [tcpflood@32473 MSGNUM="0"] body');
    expect(renderList([property('STRUCTURED-DATA', { 'position.from': 2, 'position.to': -1 }), constant('\n')], message))
      .toBe('tcpflood@32473 MSGNUM="0"\n');
  });

  it('template-topos-neg-underflow.sh: a position.to in front of position.from yields an empty string', () => {
    const message = inject('<167>Mar  1 01:00:00 h t msgnum:00000000:', { short: 'abcde', empty: '', long: 'abcdefghij' });
    const out = renderList([
      constant('short=<'), property('$!short', { 'position.from': 5, 'position.to': -2 }),
      constant('> earlier=<'), property('$!short', { 'position.from': 5, 'position.to': -3 }),
      constant('> empty=<'), property('$!empty', { 'position.from': 2, 'position.to': -2147483648 }),
      constant('> long=<'), property('$!long', { 'position.from': 5, 'position.to': -2 }), constant('>'),
    ], message);
    expect(out).toBe('short=<> earlier=<> empty=<> long=<efgh>');
  });

  it('template-json.sh: option.json escapes quotes and backslashes but never the slash', () => {
    const message = inject('<167>Mar  1 01:00:00 h t msgnum:00000000:', { backslash: 'a \\ "b" c / d' });
    const out = renderList([constant('{'), constant('"backslash":"'), property('$!backslash'), constant('"}\n')], message, { 'option.json': 'on' });
    expect(out).toBe('{"backslash":"a \\\\ \\"b\\" c / d"}\n');
  });

  it('template-const-jsonf.sh: a jsonf constant is a spaced key/value fragment', () => {
    const message = inject('<167>Mar  1 01:00:00 h t msgnum:00000000:');
    expect(renderList([constant('1', { outname: '@version', format: 'jsonf' }), constant('\n')], message)).toBe('"@version": "1"\n');
  });

  it('template-jsonf-nested.sh: option.jsonftree nests dotted names', () => {
    const message = inject('<167>Mar  1 01:00:00 h t msgnum:00000000:');
    const out = renderList([
      constant('testhost', { outname: 'host.hostname', format: 'jsonf' }), constant('127.0.0.1', { outname: 'host.ip', format: 'jsonf' }),
      constant('syslog', { outname: 'event.dataset.name', format: 'jsonf' }), property('msg', { outname: 'event.original', format: 'jsonf' }),
    ], message, { 'option.jsonftree': 'on' });
    expect(JSON.parse(out)).toEqual({
      host: { hostname: 'testhost', ip: '127.0.0.1' }, event: { dataset: { name: 'syslog' }, original: ' msgnum:00000000:' },
    });
  });

  it('template-jsonf-nested-fallback-flat.sh: conflicting keys fall back to flat JSON', () => {
    const message = inject('<167>Mar  1 01:00:00 h t msgnum:00000000:');
    const out = renderList([
      constant('A', { outname: 'a', format: 'jsonf' }), constant('B', { outname: 'a.b', format: 'jsonf' }),
    ], message, { 'option.jsonftree': 'on' });
    expect(JSON.parse(out)).toEqual({ a: 'A', 'a.b': 'B' });
  });

  it('template-regex-index-bounds.sh: out-of-range selectors are refused with the template name', () => {
    const build = (params: Params) => () => templateFromObject(list('bad', [property('msg', { 'regex.expression': '(a)', ...params })]));
    expect(build({ 'regex.submatch': -1 })).toThrow('template bad error: regex.submatch=-1 is invalid (supported range 0..9)');
    expect(build({ 'regex.match': 10 })).toThrow('template bad error: regex.match=10 is invalid (supported range 0..9)');
    expect(build({ 'regex.match': 9 })).not.toThrow();
  });
});

describe('rsyslog templates — built-in and legacy forms', () => {
  const standard = (name: string) => standardTemplates().find((template) => template.name === name)!;
  const message = () => inject('<34>Oct 11 22:14:15 mymachine su[123]: \'su root\' failed for lonvick on /dev/pts/8');

  it('RSYSLOG_TraditionalFileFormat and RSYSLOG_FileFormat insert the missing space after the tag', () => {
    const reported = message();
    expect(renderTemplate(standard('RSYSLOG_TraditionalFileFormat'), reported, context())).toBe(
      "Oct 11 22:14:15 mymachine su[123]: 'su root' failed for lonvick on /dev/pts/8\n",
    );
    const bare = inject('<34>Oct 11 22:14:15 mymachine su:x');
    expect(renderTemplate(standard('RSYSLOG_FileFormat'), bare, context())).toMatch(/^\d{4}-10-11T22:14:15\S* mymachine su: x\n$/);
  });

  it('RSYSLOG_ForwardFormat caps the tag at 32 characters and RSYSLOG_SyslogProtocol23Format renders RFC 5424', () => {
    const long = inject(`<13>Oct 11 22:14:15 h ${'t'.repeat(40)}: hello`);
    expect(renderTemplate(standard('RSYSLOG_ForwardFormat'), long, context())).toMatch(new RegExp(`^<13>\\S+ h ${'t'.repeat(32)} hello$`));
    expect(renderTemplate(standard('RSYSLOG_SyslogProtocol23Format'), message(), context())).toMatch(/^<34>1 \S+ mymachine su 123 - - /);
  });

  it('$template legacy syntax honours escapes, options and the =strgen form', () => {
    const template = parseLegacyTemplate('legacy', '"%msg%\\n\\101\\\\",sql,casesensitive')!;
    expect(template.escape).toBe('sql');
    expect(template.caseSensitive).toBe(true);
    expect(renderTemplate(template, inject("<13>Oct 11 22:14:15 h t: it's"), context())).toBe(" it\\'s\ne\\");
    expect(parseLegacyTemplate('x', '=RSYSLOG_FileFormat')?.kind).toBe('strgen');
    const reports: string[] = [];
    expect(parseLegacyTemplate('x', '=NoSuchStrgen', (text) => reports.push(text))).toBeNull();
    expect(reports[0]).toContain('NoSuchStrgen');
  });

  it('refuses a template whose options contradict each other', () => {
    expect(() => templateFromObject(list('t', [constant('x')], { 'option.sql': 'on', 'option.json': 'on' }))).toThrow(TemplateError);
    expect(() => templateFromObject({ params: { name: 't', type: 'subtree', subtree: 'nodollar' }, entries: [] })).toThrow('must start with');
  });

  it('subtree templates render the JSON tree and tplToJSON keeps typed values', () => {
    const message = inject('<13>Oct 11 22:14:15 h t: m', { usr: { a: 1, b: 'x' } });
    const subtree = templateFromObject({ params: { name: 's', type: 'subtree', subtree: '$!usr' }, entries: [] });
    expect(renderTemplate(subtree, message, context())).toBe('{ "a": 1, "b": "x" }');
    const typed = templateFromObject(list('j', [property('$!usr!a', { outname: 'a' }), property('msg', { outname: 'm' })]));
    expect(renderTemplateJson(typed, message, context())).toEqual({ a: 1, m: ' m' });
  });

  it('reads the simulated clock for %$NOW% properties so accelerated time shows through', () => {
    const template = parseStringTemplate('clock', '%$NOW% %$HOUR%:%$MINUTE%');
    const at = (ms: number) => renderTemplate(template, message(), context(ms));
    expect(at(Date.UTC(2003, 7, 24, 12, 30, 0))).toBe('2003-08-24 12:30');
    expect(at(Date.UTC(2003, 7, 24, 12, 30, 0) + 3600_000 * 13)).toBe('2003-08-25 01:30');
  });
});
