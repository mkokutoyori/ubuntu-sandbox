import { describe, it, expect } from 'vitest';
import { buildNamedConfig, NamedConfigError } from '@/network/devices/linux/bind9/NamedConfig';
import type { NamedConfig } from '@/network/devices/linux/bind9/NamedConfig';
import { parseNamedConf } from '@/network/devices/linux/bind9/NamedConfParser';
import type { AclHostEnvironment } from '@/network/devices/linux/bind9/NamedAcl';

const CONF = '/etc/bind/named.conf';

function build(source: string): NamedConfig {
  return buildNamedConfig(parseNamedConf(source, { file: CONF }));
}

const LAN_ENV: AclHostEnvironment = {
  localAddresses: ['10.0.1.10', '192.168.5.1'],
  localNetworks: [
    { address: '10.0.1.0', prefix: 24 },
    { address: '192.168.5.0', prefix: 24 },
  ],
};

describe('NamedConfig — defaults (BIND 9.18)', () => {
  const config = buildNamedConfig(parseNamedConf('options { };'));

  it('defaults recursion to yes', () => {
    expect(config.options.recursion).toBe(true);
  });

  it('defaults directory to /var/cache/bind', () => {
    expect(config.options.directory).toBe('/var/cache/bind');
  });

  it('defaults dnssec-validation to auto', () => {
    expect(config.options.dnssecValidation).toBe('auto');
  });

  it('defaults the listen port to 53', () => {
    expect(config.options.listenOnPort).toBe(53);
  });

  it('defaults allow-query to any', () => {
    expect(config.options.allowQuery.matches('203.0.113.7', LAN_ENV)).toBe(true);
  });

  it('defaults allow-recursion to localnets and localhost', () => {
    expect(config.options.allowRecursion.matches('10.0.1.23', LAN_ENV)).toBe(true);
    expect(config.options.allowRecursion.matches('127.0.0.1', LAN_ENV)).toBe(true);
    expect(config.options.allowRecursion.matches('203.0.113.7', LAN_ENV)).toBe(false);
  });

  it('defaults allow-transfer to any', () => {
    expect(config.options.allowTransfer.matches('203.0.113.7', LAN_ENV)).toBe(true);
  });

  it('defaults querylog to off and no forwarders', () => {
    expect(config.options.queryLog).toBe(false);
    expect(config.options.forwarders).toEqual([]);
  });
});

describe('NamedConfig — options clause', () => {
  it('parses a full options clause', () => {
    const config = build(`
options {
  directory "/var/cache/bind";
  recursion no;
  querylog yes;
  forwarders { 10.0.9.1; 10.0.9.2; };
  forward only;
  listen-on port 5353 { any; };
  dnssec-validation no;
  allow-query { 10.0.0.0/8; };
};
`);

    expect(config.options.recursion).toBe(false);
    expect(config.options.queryLog).toBe(true);
    expect(config.options.forwarders).toEqual(['10.0.9.1', '10.0.9.2']);
    expect(config.options.forwardMode).toBe('only');
    expect(config.options.listenOnPort).toBe(5353);
    expect(config.options.dnssecValidation).toBe('no');
    expect(config.options.allowQuery.matches('10.20.30.40', LAN_ENV)).toBe(true);
    expect(config.options.allowQuery.matches('192.0.2.1', LAN_ENV)).toBe(false);
  });

  it('rejects an unknown option with its location', () => {
    expect(() => build('options {\n  recursions yes;\n};'))
      .toThrowError(`${CONF}:2: unknown option 'recursions'`);
  });

  it('rejects a non-boolean value where yes/no is expected', () => {
    expect(() => build('options { recursion maybe; };'))
      .toThrowError(`${CONF}:1: expected boolean near 'maybe'`);
  });

  it('rejects an unknown top-level clause', () => {
    expect(() => build('optionz { };'))
      .toThrowError(`${CONF}:1: unknown option 'optionz'`);
  });
});

describe('NamedConfig — zone clauses', () => {
  it('parses a primary zone and normalizes the name', () => {
    const config = build('zone "Example.COM." { type primary; file "/etc/bind/db.example"; };');

    expect(config.zones).toHaveLength(1);
    expect(config.zones[0]).toMatchObject({
      name: 'example.com',
      type: 'primary',
      file: '/etc/bind/db.example',
    });
  });

  it('accepts master and slave as legacy aliases', () => {
    const config = build(`
zone "a.lan" { type master; file "db.a"; };
zone "b.lan" { type slave; masters { 10.0.1.10; }; file "db.b"; };
`);

    expect(config.zones[0].type).toBe('primary');
    expect(config.zones[1].type).toBe('secondary');
    expect(config.zones[1].primaries).toEqual(['10.0.1.10']);
  });

  it('parses a secondary zone with primaries and also-notify', () => {
    const config = build(`
zone "example.com" {
  type secondary;
  primaries { 10.0.1.10; 10.0.1.11; };
  also-notify { 10.0.1.12; };
  file "db.example";
};
`);

    expect(config.zones[0].primaries).toEqual(['10.0.1.10', '10.0.1.11']);
    expect(config.zones[0].alsoNotify).toEqual(['10.0.1.12']);
  });

  it('parses a forward zone', () => {
    const config = build('zone "corp.lan" { type forward; forwarders { 10.1.1.1; }; };');

    expect(config.zones[0].type).toBe('forward');
    expect(config.zones[0].forwarders).toEqual(['10.1.1.1']);
  });

  it('resolves a relative zone file against the directory option', () => {
    const config = build(`
options { directory "/var/cache/bind"; };
zone "example.com" { type primary; file "db.example"; };
`);

    expect(config.zones[0].file).toBe('/var/cache/bind/db.example');
  });

  it('supports a per-zone allow-transfer override', () => {
    const config = build(`
zone "example.com" {
  type primary;
  file "db.example";
  allow-transfer { 10.0.1.11; };
};
`);

    expect(config.zones[0].allowTransfer!.matches('10.0.1.11', LAN_ENV)).toBe(true);
    expect(config.zones[0].allowTransfer!.matches('10.0.1.12', LAN_ENV)).toBe(false);
  });

  it('rejects a zone without a type', () => {
    expect(() => build('zone "lan" {\n  file "db.lan";\n};'))
      .toThrowError(`${CONF}:1: zone 'lan': type not present`);
  });

  it('rejects an unknown zone type', () => {
    expect(() => build('zone "lan" { type primry; file "db.lan"; };'))
      .toThrowError(`${CONF}:1: zone 'lan': unknown type 'primry'`);
  });

  it('rejects a primary zone without a file', () => {
    expect(() => build('zone "lan" { type primary; };'))
      .toThrowError(`${CONF}:1: zone 'lan': missing 'file' entry`);
  });

  it('rejects a secondary zone without primaries', () => {
    expect(() => build('zone "lan" { type secondary; file "db.lan"; };'))
      .toThrowError(`${CONF}:1: zone 'lan': missing 'primaries' entry`);
  });

  it('rejects a duplicate zone with the previous definition location', () => {
    expect(() => build(
      'zone "lan" { type primary; file "db.lan"; };\nzone "lan" { type primary; file "db.lan2"; };',
    )).toThrowError(`${CONF}:2: zone 'lan': already exists previous definition: ${CONF}:1`);
  });
});

describe('NamedConfig — acl clauses', () => {
  it('matches literal addresses and CIDR prefixes', () => {
    const config = build('acl internal { 10.0.1.10; 192.168.0.0/16; };\noptions { allow-query { internal; }; };');

    const acl = config.options.allowQuery;
    expect(acl.matches('10.0.1.10', LAN_ENV)).toBe(true);
    expect(acl.matches('10.0.1.11', LAN_ENV)).toBe(false);
    expect(acl.matches('192.168.44.9', LAN_ENV)).toBe(true);
  });

  it('applies first-match semantics for negated elements', () => {
    const config = build('acl guarded { !10.0.1.66; 10.0.1.0/24; };\noptions { allow-query { guarded; }; };');

    expect(config.options.allowQuery.matches('10.0.1.66', LAN_ENV)).toBe(false);
    expect(config.options.allowQuery.matches('10.0.1.67', LAN_ENV)).toBe(true);
  });

  it('supports the localhost builtin', () => {
    const config = build('options { allow-query { localhost; }; };');

    expect(config.options.allowQuery.matches('127.0.0.1', LAN_ENV)).toBe(true);
    expect(config.options.allowQuery.matches('10.0.1.10', LAN_ENV)).toBe(true);
    expect(config.options.allowQuery.matches('10.0.1.23', LAN_ENV)).toBe(false);
  });

  it('supports the localnets builtin', () => {
    const config = build('options { allow-query { localnets; }; };');

    expect(config.options.allowQuery.matches('10.0.1.200', LAN_ENV)).toBe(true);
    expect(config.options.allowQuery.matches('172.16.0.1', LAN_ENV)).toBe(false);
  });

  it('supports the none builtin', () => {
    const config = build('options { allow-transfer { none; }; };');

    expect(config.options.allowTransfer.matches('10.0.1.10', LAN_ENV)).toBe(false);
  });

  it('rejects a reference to an undefined ACL', () => {
    expect(() => build('options { allow-query { internal; }; };'))
      .toThrowError(`${CONF}:1: undefined ACL 'internal'`);
  });

  it('rejects redefining an ACL', () => {
    expect(() => build('acl internal { 10.0.0.1; };\nacl internal { 10.0.0.2; };'))
      .toThrowError(`${CONF}:2: attempt to redefine ACL 'internal'`);
  });
});

describe('NamedConfig — logging, key and controls clauses', () => {
  it('parses channels and categories', () => {
    const config = build(`
logging {
  channel query_log { file "/var/log/named/query.log"; severity info; };
  channel discard { null; };
  category queries { query_log; };
  category xfer-out { discard; };
};
`);

    expect(config.logging.channels.get('query_log')).toMatchObject({
      target: 'file',
      path: '/var/log/named/query.log',
      severity: 'info',
    });
    expect(config.logging.channels.get('discard')).toMatchObject({ target: 'null' });
    expect(config.logging.categories.get('queries')).toEqual(['query_log']);
    expect(config.logging.categories.get('xfer-out')).toEqual(['discard']);
  });

  it('rejects a category referencing an unknown channel', () => {
    expect(() => build('logging {\n  category queries { nope; };\n};'))
      .toThrowError(`${CONF}:2: channel 'nope': not defined`);
  });

  it('parses a key clause and tolerates a controls clause', () => {
    const config = build(`
key "rndc-key" { algorithm hmac-sha256; secret "c2VjcmV0"; };
controls { inet 127.0.0.1 port 953 allow { 127.0.0.1; } keys { "rndc-key"; }; };
`);

    expect(config.keys.get('rndc-key')).toMatchObject({
      algorithm: 'hmac-sha256',
      secret: 'c2VjcmV0',
    });
  });

  it('exposes structured fields on NamedConfigError', () => {
    try {
      build('options { recursion maybe; };');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NamedConfigError);
      expect((error as NamedConfigError).file).toBe(CONF);
      expect((error as NamedConfigError).line).toBe(1);
    }
  });
});
