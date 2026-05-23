import { describe, expect, test } from 'vitest';
import {
  SshdServerConfig,
  type SshdAddressFamily,
  type SshdLogLevel,
} from '@/network/protocols/ssh/server/SshdServerConfig';

describe('§Q — SshdServerConfig immutable directive value object', () => {
  test('defaults match OpenSSH 9.x out-of-the-box', () => {
    const cfg = SshdServerConfig.defaults();
    expect(cfg.ports).toEqual([22]);
    expect(cfg.listenAddresses).toEqual(['0.0.0.0', '::']);
    expect(cfg.addressFamily).toBe<SshdAddressFamily>('any');
    expect(cfg.permitRootLogin).toBe('prohibit-password');
    expect(cfg.passwordAuthentication).toBe(true);
    expect(cfg.pubkeyAuthentication).toBe(true);
    expect(cfg.kbdInteractiveAuthentication).toBe(false);
    expect(cfg.challengeResponseAuthentication).toBe(false);
    expect(cfg.gssapiAuthentication).toBe(false);
    expect(cfg.hostbasedAuthentication).toBe(false);
    expect(cfg.maxAuthTries).toBe(6);
    expect(cfg.maxSessions).toBe(10);
    expect(cfg.maxStartups).toEqual({ start: 10, rate: 30, full: 100 });
    expect(cfg.loginGraceTimeSeconds).toBe(120);
    expect(cfg.permitEmptyPasswords).toBe(false);
    expect(cfg.allowTcpForwarding).toBe('yes');
    expect(cfg.allowAgentForwarding).toBe(true);
    expect(cfg.allowStreamLocalForwarding).toBe(true);
    expect(cfg.x11Forwarding).toBe(false);
    expect(cfg.x11DisplayOffset).toBe(10);
    expect(cfg.gatewayPorts).toBe('no');
    expect(cfg.tcpKeepAlive).toBe(true);
    expect(cfg.clientAliveIntervalSeconds).toBe(0);
    expect(cfg.clientAliveCountMax).toBe(3);
    expect(cfg.printMotd).toBe(true);
    expect(cfg.printLastLog).toBe(true);
    expect(cfg.useDns).toBe(false);
    expect(cfg.useLogin).toBe(false);
    expect(cfg.usePam).toBe(true);
    expect(cfg.permitUserEnvironment).toBe(false);
    expect(cfg.strictModes).toBe(true);
    expect(cfg.compression).toBe('delayed');
    expect(cfg.logLevel).toBe<SshdLogLevel>('INFO');
    expect(cfg.syslogFacility).toBe('AUTH');
    expect(cfg.bannerPath).toBeNull();
    expect(cfg.motdPath).toBe('/etc/motd');
    expect(cfg.subsystems.sftp).toMatch(/sftp-server/);
    expect(cfg.allowUsers).toEqual([]);
    expect(cfg.denyUsers).toEqual([]);
    expect(cfg.allowGroups).toEqual([]);
    expect(cfg.denyGroups).toEqual([]);
    expect(cfg.acceptEnv).toEqual([]);
    expect(cfg.ciphers.length).toBeGreaterThan(0);
    expect(cfg.macs.length).toBeGreaterThan(0);
    expect(cfg.kexAlgorithms.length).toBeGreaterThan(0);
    expect(cfg.hostKeyAlgorithms.length).toBeGreaterThan(0);
    expect(cfg.matchBlocks).toEqual([]);
  });

  test('mutators return new immutable instances', () => {
    const base = SshdServerConfig.defaults();
    const next = base
      .withPort(2222)
      .withPermitRootLogin('no')
      .withMaxAuthTries(3)
      .withAllowUsers(['alice', 'bob'])
      .withDenyUsers(['root'])
      .withAcceptEnv(['LC_*', 'LANG']);
    expect(base.ports).toEqual([22]);
    expect(next.ports).toEqual([22, 2222]);
    expect(next.permitRootLogin).toBe('no');
    expect(next.maxAuthTries).toBe(3);
    expect(next.allowUsers).toEqual(['alice', 'bob']);
    expect(next.denyUsers).toEqual(['root']);
    expect(next.acceptEnv).toEqual(['LC_*', 'LANG']);
  });

  test('withPort dedupes and sorts ascending', () => {
    const cfg = SshdServerConfig.defaults().withPort(2222).withPort(2222).withPort(2022);
    expect(cfg.ports).toEqual([22, 2022, 2222]);
  });

  test('parse() reconstructs every common directive from a real sshd_config', () => {
    const raw = [
      '# OpenSSH demo config',
      'Port 22',
      'Port 2222',
      'AddressFamily inet',
      'ListenAddress 0.0.0.0',
      'PermitRootLogin no',
      'PasswordAuthentication yes',
      'PubkeyAuthentication yes',
      'KbdInteractiveAuthentication no',
      'MaxAuthTries 4',
      'MaxSessions 5',
      'MaxStartups 10:30:60',
      'LoginGraceTime 30',
      'AllowTcpForwarding yes',
      'AllowAgentForwarding yes',
      'X11Forwarding yes',
      'PermitEmptyPasswords no',
      'GatewayPorts clientspecified',
      'TCPKeepAlive yes',
      'ClientAliveInterval 60',
      'ClientAliveCountMax 2',
      'PrintMotd yes',
      'UseDNS no',
      'StrictModes yes',
      'AllowUsers alice bob',
      'DenyUsers root mallory',
      'AllowGroups admins',
      'DenyGroups guests',
      'AcceptEnv LC_* LANG',
      'Banner /etc/issue.net',
      'Subsystem sftp internal-sftp',
      'LogLevel VERBOSE',
      'SyslogFacility AUTHPRIV',
      'Match User alice',
      '    PasswordAuthentication no',
      '    AllowTcpForwarding no',
    ].join('\n');
    const cfg = SshdServerConfig.parse(raw);
    expect(cfg.ports).toEqual([22, 2222]);
    expect(cfg.addressFamily).toBe('inet');
    expect(cfg.permitRootLogin).toBe('no');
    expect(cfg.maxAuthTries).toBe(4);
    expect(cfg.maxStartups).toEqual({ start: 10, rate: 30, full: 60 });
    expect(cfg.loginGraceTimeSeconds).toBe(30);
    expect(cfg.x11Forwarding).toBe(true);
    expect(cfg.gatewayPorts).toBe('clientspecified');
    expect(cfg.clientAliveIntervalSeconds).toBe(60);
    expect(cfg.useDns).toBe(false);
    expect(cfg.allowUsers).toEqual(['alice', 'bob']);
    expect(cfg.denyUsers).toEqual(['root', 'mallory']);
    expect(cfg.allowGroups).toEqual(['admins']);
    expect(cfg.denyGroups).toEqual(['guests']);
    expect(cfg.acceptEnv).toEqual(['LC_*', 'LANG']);
    expect(cfg.bannerPath).toBe('/etc/issue.net');
    expect(cfg.subsystems.sftp).toBe('internal-sftp');
    expect(cfg.logLevel).toBe('VERBOSE');
    expect(cfg.syslogFacility).toBe('AUTHPRIV');
    expect(cfg.matchBlocks).toHaveLength(1);
    expect(cfg.matchBlocks[0].criteria).toEqual([{ keyword: 'User', value: 'alice' }]);
    expect(cfg.matchBlocks[0].overrides.passwordAuthentication).toBe(false);
    expect(cfg.matchBlocks[0].overrides.allowTcpForwarding).toBe('no');
  });

  test('serialize() round-trips parse() faithfully', () => {
    const cfg = SshdServerConfig.parse('Port 22\nPort 2222\nPermitRootLogin no\nMaxAuthTries 3\n');
    const text = cfg.serialize();
    const cfg2 = SshdServerConfig.parse(text);
    expect(cfg2.ports).toEqual(cfg.ports);
    expect(cfg2.permitRootLogin).toBe(cfg.permitRootLogin);
    expect(cfg2.maxAuthTries).toBe(cfg.maxAuthTries);
  });

  test('effectiveFor(user) merges matching Match blocks', () => {
    const raw = [
      'PasswordAuthentication yes',
      'Match User alice',
      '    PasswordAuthentication no',
      'Match Group admins',
      '    MaxAuthTries 2',
    ].join('\n');
    const cfg = SshdServerConfig.parse(raw);
    const aliceView = cfg.effectiveFor({ user: 'alice', groups: ['users'] });
    expect(aliceView.passwordAuthentication).toBe(false);
    const bobView = cfg.effectiveFor({ user: 'bob', groups: ['admins'] });
    expect(bobView.passwordAuthentication).toBe(true);
    expect(bobView.maxAuthTries).toBe(2);
  });

  test('denyUsers takes precedence over allowUsers when both match', () => {
    const cfg = SshdServerConfig.defaults()
      .withAllowUsers(['alice'])
      .withDenyUsers(['alice']);
    expect(cfg.isUserAllowed('alice', [])).toBe(false);
  });

  test('isUserAllowed honours wildcard globs', () => {
    const cfg = SshdServerConfig.defaults().withAllowUsers(['ali*']);
    expect(cfg.isUserAllowed('alice', [])).toBe(true);
    expect(cfg.isUserAllowed('bob', [])).toBe(false);
  });

  test('isUserAllowed honours group glob membership', () => {
    const cfg = SshdServerConfig.defaults()
      .withAllowGroups(['wheel'])
      .withAllowUsers([]);
    expect(cfg.isUserAllowed('alice', ['wheel'])).toBe(true);
    expect(cfg.isUserAllowed('alice', ['users'])).toBe(false);
  });
});
