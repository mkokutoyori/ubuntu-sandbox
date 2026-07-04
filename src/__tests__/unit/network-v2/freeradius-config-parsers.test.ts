import { describe, it, expect } from 'vitest';
import { parseClientsConf } from '@/network/devices/linux/freeradius/ClientsConfParser';
import { parseUsersFile } from '@/network/devices/linux/freeradius/UsersFileParser';

describe('parseClientsConf', () => {
  it('parses a client block keyed by dotted-quad name with an implicit ipaddr', () => {
    const source = `
client 10.0.0.1 {
    secret = testing123
}
`;
    expect(parseClientsConf(source)).toEqual([
      { name: '10.0.0.1', ipaddr: '10.0.0.1', secret: 'testing123' },
    ]);
  });

  it('parses an explicit ipaddr and a quoted secret', () => {
    const source = `
client nas1 {
    ipaddr = 10.0.0.5
    secret = "shared secret"
}
`;
    expect(parseClientsConf(source)).toEqual([
      { name: 'nas1', ipaddr: '10.0.0.5', secret: 'shared secret' },
    ]);
  });

  it('parses multiple client blocks and ignores comments', () => {
    const source = `
# The office NAS
client 10.0.0.1 {
    secret = testing123 # inline comment
}

client 10.0.0.2 {
    secret = other-secret
}
`;
    const parsed = parseClientsConf(source);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ name: '10.0.0.1', ipaddr: '10.0.0.1', secret: 'testing123' });
    expect(parsed[1]).toEqual({ name: '10.0.0.2', ipaddr: '10.0.0.2', secret: 'other-secret' });
  });

  it('skips a client block with no secret', () => {
    const source = `
client 10.0.0.1 {
    ipaddr = 10.0.0.1
}
`;
    expect(parseClientsConf(source)).toEqual([]);
  });

  it('returns an empty array for a file with no client blocks', () => {
    expect(parseClientsConf('# empty config\n')).toEqual([]);
  });
});

describe('parseUsersFile', () => {
  it('parses a single Cleartext-Password entry', () => {
    const source = 'alice Cleartext-Password := "wonderland"\n';
    expect(parseUsersFile(source)).toEqual([{ username: 'alice', password: 'wonderland' }]);
  });

  it('parses multiple entries and ignores comments/blank lines', () => {
    const source = `
# users file
alice Cleartext-Password := "wonderland"

bob   Cleartext-Password := "hunter2"
`;
    expect(parseUsersFile(source)).toEqual([
      { username: 'alice', password: 'wonderland' },
      { username: 'bob', password: 'hunter2' },
    ]);
  });

  it('accepts both := and = as the check-item operator', () => {
    const source = 'alice Cleartext-Password = "wonderland"\n';
    expect(parseUsersFile(source)).toEqual([{ username: 'alice', password: 'wonderland' }]);
  });

  it('returns an empty array for a file with no recognized entries', () => {
    expect(parseUsersFile('# nobody here\n')).toEqual([]);
  });
});
