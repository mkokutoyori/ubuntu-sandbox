import { describe, it, expect } from 'vitest';
import { parseClientsConf } from '@/network/devices/linux/freeradius/ClientsConfParser';
import { parseUsersFile, matchUsersEntries } from '@/network/devices/linux/freeradius/UsersFileParser';

describe('parseClientsConf', () => {
  const FILE = '/etc/freeradius/3.0/clients.conf';

  it('reads an old-style client named by its address, and warns as the real parser does', () => {
    const parsed = parseClientsConf('client 10.0.0.1 {\n    secret = testing123\n}\n', FILE);
    expect(parsed.errors).toEqual([]);
    expect(parsed.clients.map((c) => [c.name, c.address.toString(), c.prefix, c.secret])).toEqual([['10.0.0.1', '10.0.0.1', 32, 'testing123']]);
    expect(parsed.warnings[0]).toContain("No 'ipaddr' or 'ipv4addr' or 'ipv6addr' field found in client 10.0.0.1");
  });

  it('reads ipaddr, a quoted secret, shortname and nas_type', () => {
    const parsed = parseClientsConf('client nas1 {\n    ipaddr = 10.0.0.5\n    secret = "shared secret"\n    shortname = edge\n    nas_type = cisco\n}\n', FILE);
    const [client] = parsed.clients;
    expect([client.name, client.shortname, client.secret, client.nasType]).toEqual(['10.0.0.5', 'edge', 'shared secret', 'cisco']);
  });

  it('reads several clients and ignores comments, with a prefix on ipaddr', () => {
    const parsed = parseClientsConf('# The office NAS\nclient a {\n    ipaddr = 10.0.0.0/24\n    secret = testing123 # inline\n}\nclient b {\n    ipaddr = 10.0.1.2\n    secret = other-secret\n}\n', FILE);
    expect(parsed.clients.map((c) => [c.address.toString(), c.prefix, c.secret])).toEqual([['10.0.0.0', 24, 'testing123'], ['10.0.1.2', 32, 'other-secret']]);
  });

  it('refuses a client with no secret, naming the section line like cf_log_err_cs', () => {
    const parsed = parseClientsConf('client nas1 {\n    ipaddr = 10.0.0.1\n}\n', FILE);
    expect(parsed.errors).toEqual([`${FILE}[1]: secret must be at least 1 character long`]);
  });

  it('reports a file without any client section', () => {
    expect(parseClientsConf('# empty config\n', FILE).errors).toEqual([`${FILE}: No "client" section found in client file`]);
  });

  it('reports an unterminated section and a stray closing brace with the conffile.c wording', () => {
    expect(parseClientsConf('client a {\n  secret = x\n', FILE).errors).toEqual([`${FILE}[3]: EOF reached without closing brace for section client starting at line 1`]);
    expect(parseClientsConf('}\n', FILE).errors).toEqual([`${FILE}[1]: Too many closing braces`]);
  });

  it('expands ${variables} defined earlier and $INCLUDEs another file', () => {
    const reader = (path: string): string | null => (path === '/etc/freeradius/3.0/extra.conf' ? 'client b {\n  ipaddr = 10.9.9.9\n  secret = ${shared}\n}\n' : null);
    const parsed = parseClientsConf('shared = hunter2hunter2\n$INCLUDE extra.conf\n', FILE, reader);
    expect(parsed.errors).toEqual([]);
    expect(parsed.clients[0].secret).toBe('hunter2hunter2');
  });

  it('reports an unknown ${reference} and a missing include', () => {
    expect(parseClientsConf('client a {\n ipaddr = 1.1.1.1\n secret = ${nope}\n}\n', FILE).errors).toEqual([`${FILE}[3]: Reference '\${nope}' not found`]);
    expect(parseClientsConf('$INCLUDE missing.conf\n', FILE).errors[0]).toContain("Unable to open file '/etc/freeradius/3.0/missing.conf'");
  });
});

describe('parseUsersFile', () => {
  const parse = (source: string) => parseUsersFile(source, '/etc/freeradius/3.0/users', () => null);
  const passwordOf = (source: string, name: string) => {
    const parsed = parse(source);
    if ('error' in parsed) throw new Error(parsed.error);
    return matchUsersEntries(parsed.entries, name, () => undefined)?.password;
  };

  it('parses a single Cleartext-Password entry', () => {
    expect(passwordOf('alice Cleartext-Password := "wonderland"\n', 'alice')).toBe('wonderland');
  });

  it('parses multiple entries and ignores comments/blank lines', () => {
    const source = '\n# users file\nalice Cleartext-Password := "wonderland"\n\nbob   Cleartext-Password := "hunter2"\n';
    expect(passwordOf(source, 'alice')).toBe('wonderland');
    expect(passwordOf(source, 'bob')).toBe('hunter2');
  });

  it('accepts both := and = as the check-item operator', () => {
    expect(passwordOf('alice Cleartext-Password = "wonderland"\n', 'alice')).toBe('wonderland');
  });

  it('returns no entry for a file with no recognized entries', () => {
    const parsed = parse('# nobody here\n');
    expect('entries' in parsed && parsed.entries).toEqual([]);
  });
});
