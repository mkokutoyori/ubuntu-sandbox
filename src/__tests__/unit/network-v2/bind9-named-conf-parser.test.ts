import { describe, it, expect } from 'vitest';
import { lexNamedConf, NamedConfSyntaxError } from '@/network/devices/linux/bind9/NamedConfLexer';
import { parseNamedConf } from '@/network/devices/linux/bind9/NamedConfParser';
import type { NamedConfStatement } from '@/network/devices/linux/bind9/NamedConfParser';

const CONF = '/etc/bind/named.conf';

function parse(source: string, readInclude?: (path: string) => string | null): NamedConfStatement[] {
  return parseNamedConf(source, { file: CONF, readInclude });
}

function keywords(statements: NamedConfStatement[]): string[] {
  return statements.map((s) => s.values[0].text);
}

describe('NamedConfLexer', () => {
  it('lexes words, strings, braces and semicolons with positions', () => {
    const tokens = lexNamedConf('zone "example.com" {\n  file "db.example";\n};\n', CONF);

    expect(tokens.map((t) => t.kind)).toEqual([
      'word', 'string', '{', 'word', 'string', ';', '}', ';',
    ]);
    expect(tokens[0]).toMatchObject({ text: 'zone', line: 1, column: 1, file: CONF });
    expect(tokens[3]).toMatchObject({ text: 'file', line: 2, column: 3 });
  });

  it('skips the three comment styles', () => {
    const source = [
      '// C++ style',
      'recursion yes; # shell style',
      '/* C style',
      '   over two lines */',
      'querylog no;',
    ].join('\n');

    const tokens = lexNamedConf(source, CONF);

    expect(tokens.map((t) => t.text)).toEqual(['recursion', 'yes', ';', 'querylog', 'no', ';']);
  });

  it('keeps spaces and special characters inside quoted strings', () => {
    const tokens = lexNamedConf('key "rndc key name" { secret "a/b+c="; };', CONF);

    expect(tokens[1]).toMatchObject({ kind: 'string', text: 'rndc key name' });
    expect(tokens[4]).toMatchObject({ kind: 'string', text: 'a/b+c=' });
  });

  it('emits ! as a separate token even when glued to an address', () => {
    const tokens = lexNamedConf('acl internal { !10.0.0.1; 10.0.0.0/8; };', CONF);

    expect(tokens.map((t) => t.text)).toEqual([
      'acl', 'internal', '{', '!', '10.0.0.1', ';', '10.0.0.0/8', ';', '}', ';',
    ]);
  });

  it('rejects an unterminated string with file and line', () => {
    expect(() => lexNamedConf('directory "/var/cache/bind\n;', CONF))
      .toThrowError(`${CONF}:1: unterminated string`);
  });

  it('rejects an unterminated block comment', () => {
    expect(() => lexNamedConf('recursion yes;\n/* never closed', CONF))
      .toThrowError(`${CONF}:2: unterminated comment`);
  });
});

describe('NamedConfParser', () => {
  it('parses a realistic Ubuntu options clause', () => {
    const statements = parse(`
options {
        directory "/var/cache/bind";
        recursion yes;
        listen-on port 53 { any; };
        forwarders {
                8.8.8.8;
                1.1.1.1;
        };
        dnssec-validation auto;
};
`);

    expect(statements).toHaveLength(1);
    const options = statements[0];
    expect(options.values[0].text).toBe('options');
    expect(options.block).not.toBeNull();
    expect(keywords(options.block!)).toEqual([
      'directory', 'recursion', 'listen-on', 'forwarders', 'dnssec-validation',
    ]);

    const listenOn = options.block![2];
    expect(listenOn.values.map((v) => v.text)).toEqual(['listen-on', 'port', '53']);
    expect(keywords(listenOn.block!)).toEqual(['any']);

    const forwarders = options.block![3];
    expect(keywords(forwarders.block!)).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('parses a zone clause with quoted name and class', () => {
    const statements = parse('zone "example.com" IN { type primary; file "/etc/bind/db.example"; };');

    const zone = statements[0];
    expect(zone.values.map((v) => v.text)).toEqual(['zone', 'example.com', 'IN']);
    expect(zone.values[1].quoted).toBe(true);
    expect(zone.block![0].values.map((v) => v.text)).toEqual(['type', 'primary']);
    expect(zone.block![1].values[1].quoted).toBe(true);
  });

  it('parses nested logging channels and categories', () => {
    const statements = parse(`
logging {
        channel query_log {
                file "/var/log/named/query.log";
                severity info;
        };
        category queries { query_log; };
};
`);

    const logging = statements[0];
    const channel = logging.block![0];
    expect(channel.values.map((v) => v.text)).toEqual(['channel', 'query_log']);
    expect(keywords(channel.block!)).toEqual(['file', 'severity']);
    const category = logging.block![1];
    expect(category.values.map((v) => v.text)).toEqual(['category', 'queries']);
    expect(keywords(category.block!)).toEqual(['query_log']);
  });

  it('records the source line of every statement', () => {
    const statements = parse('recursion yes;\n\nquerylog no;');

    expect(statements[0].line).toBe(1);
    expect(statements[1].line).toBe(3);
  });

  it('splices include files and attributes statements to the included file', () => {
    const files: Record<string, string> = {
      '/etc/bind/named.conf.options': 'options { recursion no; };',
      '/etc/bind/named.conf.local': 'zone "lan" { type primary; file "db.lan"; };',
    };
    const statements = parse(
      'include "/etc/bind/named.conf.options";\ninclude "/etc/bind/named.conf.local";',
      (path) => files[path] ?? null,
    );

    expect(keywords(statements)).toEqual(['options', 'zone']);
    expect(statements[0].file).toBe('/etc/bind/named.conf.options');
    expect(statements[1].file).toBe('/etc/bind/named.conf.local');
  });

  it('reports a missing include file like BIND does', () => {
    expect(() => parse('include "/etc/bind/absent.conf";', () => null))
      .toThrowError(`${CONF}:1: open: /etc/bind/absent.conf: file not found`);
  });

  it('reports a missing semicolon before a closing brace', () => {
    expect(() => parse('options {\n  recursion yes\n};'))
      .toThrowError(`${CONF}:3: missing ';' before '}'`);
  });

  it('reports a missing semicolon at end of file', () => {
    expect(() => parse('recursion yes'))
      .toThrowError(`${CONF}:1: missing ';' before end of file`);
  });

  it('reports an unexpected closing brace', () => {
    expect(() => parse('};'))
      .toThrowError(`${CONF}:1: unexpected '}'`);
  });

  it('reports an unclosed block at end of file', () => {
    expect(() => parse('options {\n  recursion yes;\n'))
      .toThrowError(`${CONF}:1: missing '}' before end of file`);
  });

  it('rejects a statement starting with a semicolon', () => {
    expect(() => parse(';'))
      .toThrowError(`${CONF}:1: unexpected ';'`);
  });

  it('parses an empty configuration to an empty list', () => {
    expect(parse('')).toEqual([]);
    expect(parse('\n// only comments\n')).toEqual([]);
  });

  it('surfaces syntax errors as NamedConfSyntaxError with structured fields', () => {
    try {
      parse('options {');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NamedConfSyntaxError);
      const syntaxError = error as NamedConfSyntaxError;
      expect(syntaxError.file).toBe(CONF);
      expect(syntaxError.line).toBe(1);
    }
  });
});
