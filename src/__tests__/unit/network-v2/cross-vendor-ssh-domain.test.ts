import { describe, expect, test } from 'vitest';
import {
  SshdServerConfig,
  type SshdAddressFamily,
  type SshdLogLevel,
} from '@/network/protocols/ssh/server/SshdServerConfig';
import {
  SshHostKeyMaterial,
  SshHostKeyset,
  type SshHostKeyAlgorithm,
} from '@/network/protocols/ssh/server/SshHostKeyset';
import { CrossVendorSshHost } from '@/network/protocols/ssh/server/CrossVendorSshHost';
import { EventBus } from '@/events/EventBus';
import { NetworkOsAccount } from '@/network/devices/router/aaa/NetworkOsAccount';
import { NetworkOsCredentialStore } from '@/network/devices/router/aaa/NetworkOsCredentialStore';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

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

describe('§R — SshHostKeyMaterial faithfully models a server host key', () => {
  test('factory generates a deterministic ed25519 key from a seed', () => {
    const k = SshHostKeyMaterial.generate('ssh-ed25519', { seed: 'router-r1' });
    expect(k.algorithm).toBe('ssh-ed25519');
    expect(k.keySizeBits).toBe(256);
    expect(k.publicKey).toMatch(/^ssh-ed25519\s+/);
    expect(k.privateKeyPem).toMatch(/BEGIN OPENSSH PRIVATE KEY/);
    expect(k.fingerprintSha256).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(k.fingerprintMd5).toMatch(/^MD5:([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
    expect(k.fingerprintBabble).toMatch(/^x[a-z-]+x$/);
    expect(k.createdAt).toBeGreaterThan(0);
    expect(k.serialized()).toContain('ssh-ed25519');
  });

  test('rsa key reports its bit length', () => {
    const k = SshHostKeyMaterial.generate('ssh-rsa', { seed: 'router-r1', bits: 4096 });
    expect(k.algorithm).toBe('ssh-rsa');
    expect(k.keySizeBits).toBe(4096);
  });

  test('ecdsa key reports curve and size', () => {
    const k = SshHostKeyMaterial.generate('ecdsa-sha2-nistp256', { seed: 'r1' });
    expect(k.curveName).toBe('nistp256');
    expect(k.keySizeBits).toBe(256);
  });

  test('two keys built from the same seed are byte-identical', () => {
    const a = SshHostKeyMaterial.generate('ssh-ed25519', { seed: 'same' });
    const b = SshHostKeyMaterial.generate('ssh-ed25519', { seed: 'same' });
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.fingerprintSha256).toBe(b.fingerprintSha256);
  });

  test('different seeds produce different keys', () => {
    const a = SshHostKeyMaterial.generate('ssh-ed25519', { seed: 'x' });
    const b = SshHostKeyMaterial.generate('ssh-ed25519', { seed: 'y' });
    expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
  });

  test('known_hosts line matches the OpenSSH format', () => {
    const k = SshHostKeyMaterial.generate('ssh-ed25519', { seed: 'host' });
    expect(k.knownHostsLine('10.0.0.1')).toBe(`10.0.0.1 ${k.publicKey}`);
  });
});

describe('§R2 — SshHostKeyset manages multiple algorithms per device', () => {
  test('default keyset ships ed25519 + rsa + ecdsa', () => {
    const ks = SshHostKeyset.defaults('r1');
    expect(ks.algorithms().sort()).toEqual<SshHostKeyAlgorithm[]>(
      ['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa'].sort() as SshHostKeyAlgorithm[],
    );
    expect(ks.get('ssh-ed25519')?.algorithm).toBe('ssh-ed25519');
  });

  test('preferred returns the strongest available', () => {
    const ks = SshHostKeyset.defaults('r1');
    expect(ks.preferred().algorithm).toBe('ssh-ed25519');
  });

  test('regenerate replaces a single key but leaves the others', () => {
    const ks = SshHostKeyset.defaults('r1');
    const before = ks.get('ssh-ed25519')!.fingerprintSha256;
    const ks2 = ks.regenerate('ssh-ed25519', { seed: 'rotated' });
    expect(ks2.get('ssh-ed25519')!.fingerprintSha256).not.toBe(before);
    expect(ks2.get('ssh-rsa')!.fingerprintSha256).toBe(ks.get('ssh-rsa')!.fingerprintSha256);
  });

  test('add() inserts a new algorithm', () => {
    const ks = new SshHostKeyset([SshHostKeyMaterial.generate('ssh-ed25519', { seed: 'r1' })]);
    const ks2 = ks.add(SshHostKeyMaterial.generate('ssh-rsa', { seed: 'r1' }));
    expect(ks2.algorithms()).toContain('ssh-rsa');
  });

  test('fingerprintsBundle returns every fingerprint keyed by algorithm', () => {
    const ks = SshHostKeyset.defaults('r1');
    const bundle = ks.fingerprintsBundle();
    expect(Object.keys(bundle).sort()).toEqual(
      ['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa'],
    );
    expect(bundle['ssh-ed25519']).toMatch(/^SHA256:/);
  });
});


describe('§T — CrossVendorSshHost composes config + keys + credentials uniformly', () => {
  test('exposes deviceId, hostname, vendor, banner, motd, keyset, config', () => {
    const bus = new EventBus();
    const store = new NetworkOsCredentialStore({ deviceId: 'r1', bus });
    const host = new CrossVendorSshHost({
      deviceId: 'r1', hostname: 'r1', vendor: 'cisco', bus, credentials: store,
    });
    expect(host.deviceId).toBe('r1');
    expect(host.hostname).toBe('r1');
    expect(host.vendor).toBe('cisco');
    expect(host.config).toBeInstanceOf(SshdServerConfig);
    expect(host.keyset).toBeInstanceOf(SshHostKeyset);
    expect(host.banner).toBe('');
    expect(host.motd).toBe('');
    expect(host.getCredentials()).toBe(store);
  });

  test('isSshActive reflects the admin flag (true by default)', () => {
    const bus = new EventBus();
    const host = new CrossVendorSshHost({
      deviceId: 'r1', hostname: 'r1', vendor: 'cisco', bus,
      credentials: new NetworkOsCredentialStore({ deviceId: 'r1', bus }),
    });
    expect(host.isSshActive()).toBe(true);
    host.setSshActive(false);
    expect(host.isSshActive()).toBe(false);
  });

  test('setHostname / setBanner / setMotd mutate the facade in place', () => {
    const bus = new EventBus();
    const host = new CrossVendorSshHost({
      deviceId: 'r1', hostname: 'r1', vendor: 'cisco', bus,
      credentials: new NetworkOsCredentialStore({ deviceId: 'r1', bus }),
    });
    host.setHostname('r1-renamed');
    host.setBanner('AUTH NOTICE');
    host.setMotd('hello');
    expect(host.hostname).toBe('r1-renamed');
    expect(host.banner).toBe('AUTH NOTICE');
    expect(host.motd).toBe('hello');
  });

  test('applyConfig and applyKeyset swap the immutable inner state', () => {
    const bus = new EventBus();
    const host = new CrossVendorSshHost({
      deviceId: 'r1', hostname: 'r1', vendor: 'cisco', bus,
      credentials: new NetworkOsCredentialStore({ deviceId: 'r1', bus }),
    });
    host.applyConfig(host.config.withMaxAuthTries(2));
    expect(host.config.maxAuthTries).toBe(2);
    const ks = SshHostKeyset.defaults('rotated');
    host.applyKeyset(ks);
    expect(host.keyset).toBe(ks);
  });
});

describe('§W — SshKnownHostsFile models OpenSSH known_hosts faithfully', () => {
  test('parse extracts an ed25519 entry', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.parse('10.0.0.2 ssh-ed25519 AAAA host@r2\n');
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0].hostnames).toEqual(['10.0.0.2']);
    expect(f.entries[0].keyType).toBe('ssh-ed25519');
    expect(f.entries[0].publicKey).toBe('AAAA');
    expect(f.entries[0].comment).toBe('host@r2');
    expect(f.entries[0].revoked).toBe(false);
    expect(f.entries[0].markedCa).toBe(false);
  });

  test('@revoked marker is captured', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.parse('@revoked 10.0.0.2 ssh-rsa AAAA\n');
    expect(f.entries[0].revoked).toBe(true);
  });

  test('@cert-authority marker is captured', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.parse('@cert-authority *.example.com ssh-rsa AAAA\n');
    expect(f.entries[0].markedCa).toBe(true);
  });

  test('hashed hostnames are recognised', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.parse('|1|abc|def ssh-ed25519 AAAA\n');
    expect(f.entries[0].hashed).toBe(true);
  });

  test('comma-separated hostnames + port-specific [host]:port are split', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.parse('10.0.0.2,r2,[10.0.0.2]:2222 ssh-ed25519 AAAA\n');
    expect(f.entries[0].hostnames).toEqual(['10.0.0.2', 'r2', '[10.0.0.2]:2222']);
    expect(f.entries[0].matches('10.0.0.2')).toBe(true);
    expect(f.entries[0].matches('r2')).toBe(true);
    expect(f.entries[0].matchesHostPort('10.0.0.2', 2222)).toBe(true);
  });

  test('add(host, keyType, publicKey) inserts a fresh entry', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.empty().add({ hostnames: ['10.0.0.2'], keyType: 'ssh-ed25519', publicKey: 'AAAA' });
    expect(f.entries[0].publicKey).toBe('AAAA');
  });

  test('remove(host) drops every matching entry', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.parse('10.0.0.2 ssh-ed25519 AAAA\n10.0.0.3 ssh-ed25519 BBBB\n')
      .remove('10.0.0.2');
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0].hostnames).toEqual(['10.0.0.3']);
  });

  test('hostKeyChanged returns true when storing a different key for the same host', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const f = SshKnownHostsFile.parse('10.0.0.2 ssh-ed25519 AAAA\n');
    expect(f.hostKeyChanged('10.0.0.2', 'ssh-ed25519', 'XXXX')).toBe(true);
    expect(f.hostKeyChanged('10.0.0.2', 'ssh-ed25519', 'AAAA')).toBe(false);
    expect(f.hostKeyChanged('10.0.0.3', 'ssh-ed25519', 'YYYY')).toBe(false);
  });

  test('serialize() round-trips with parse()', async () => {
    const { SshKnownHostsFile } = await import('@/network/protocols/ssh/SshKnownHostsFile');
    const src = '10.0.0.2 ssh-ed25519 AAAA host@r2\n@revoked 10.0.0.3 ssh-rsa BBBB\n';
    const f = SshKnownHostsFile.parse(src);
    const text = f.serialize();
    const f2 = SshKnownHostsFile.parse(text);
    expect(f2.entries.length).toBe(f.entries.length);
    expect(f2.entries[1].revoked).toBe(true);
  });
});

describe('§U — Router & LinuxMachine expose a CrossVendorSshHost facade', () => {
  beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

  test('CiscoRouter.getSshHost is a CrossVendorSshHost tagged cisco', () => {
    const r = new CiscoRouter('r1', 0, 0);
    const host = r.getSshHost();
    expect(host).toBeInstanceOf(CrossVendorSshHost);
    expect(host.vendor).toBe('cisco');
    expect(host.deviceId).toBe(r.getId());
    expect(host.hostname).toBe('r1');
  });

  test('HuaweiRouter.getSshHost is a CrossVendorSshHost tagged huawei', () => {
    const r = new HuaweiRouter('hwR1', 0, 0);
    const host = r.getSshHost();
    expect(host.vendor).toBe('huawei');
  });

  test('LinuxPC.getSshHost is a CrossVendorSshHost tagged linux', () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const host = pc.getSshHost();
    expect(host.vendor).toBe('linux');
    expect(host.deviceId).toBe(pc.getId());
  });

  test('Cisco transport input none flips host.isSshActive false', async () => {
    const r = new CiscoRouter('r1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('line vty 0 4');
    await r.executeCommand('transport input none');
    await r.executeCommand('end');
    expect(r.getSshHost().isSshActive()).toBe(false);
  });

  test('Cisco banner motd reaches host.banner', async () => {
    const r = new CiscoRouter('r1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('banner motd # AUTH NOTICE #');
    await r.executeCommand('end');
    expect(r.getSshHost().banner).toBe('AUTH NOTICE');
  });

  test('Huawei header login information reaches host.banner', async () => {
    const r = new HuaweiRouter('hwR1', 0, 0);
    await r.executeCommand('system-view');
    await r.executeCommand('header login information "VRP NOTICE"');
    await r.executeCommand('quit');
    expect(r.getSshHost().banner).toBe('VRP NOTICE');
  });

  test('LinuxMachine host config follows /etc/ssh/sshd_config edits', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    await pc.executeCommand('echo "PermitRootLogin no\\nMaxAuthTries 2\\n" > /etc/ssh/sshd_config');
    const host = pc.getSshHost();
    expect(host.config.permitRootLogin).toBe('no');
    expect(host.config.maxAuthTries).toBe(2);
  });
});

