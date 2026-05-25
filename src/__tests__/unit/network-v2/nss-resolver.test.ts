/**
 * Name Service Switch — resolver unit tests.
 *
 * Verifies the dispatch logic of {@link NameServiceSwitch}: per-database
 * source ordering, `[STATUS=action]` rules, fallback config when
 * `/etc/nsswitch.conf` is missing, and reactive cache invalidation
 * via the IAM/topology event bus.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { NameServiceSwitch } from '@/network/devices/linux/nss/NameServiceSwitch';
import { FilesNssSource } from '@/network/devices/linux/nss/FilesNssSource';
import { DnsNssSource } from '@/network/devices/linux/nss/DnsNssSource';
import { parseNsswitchConf, effectiveAction } from '@/network/devices/linux/nss/NssConfig';
import { IPAddress, SubnetMask } from '@/network/core/types';

describe('NSS — config parsing', () => {
  it('parses the Ubuntu 22.04 default nsswitch.conf', () => {
    const body = [
      'passwd:         files systemd',
      'group:          files systemd',
      'hosts:          files dns',
    ].join('\n');
    const out = parseNsswitchConf(body);
    expect(out).toHaveLength(3);
    expect(out[0].database).toBe('passwd');
    expect(out[0].sources.map(s => s.name)).toEqual(['files', 'systemd']);
    expect(out[2].sources.map(s => s.name)).toEqual(['files', 'dns']);
  });

  it('honours [NOTFOUND=return] / [SUCCESS=continue] action overrides', () => {
    const body = 'hosts:  files [NOTFOUND=return] dns';
    const out = parseNsswitchConf(body);
    expect(out[0].sources[0].actions.NOTFOUND).toBe('return');
    expect(out[0].sources[1].actions.NOTFOUND).toBeUndefined();
  });

  it('drops malformed lines silently', () => {
    const body = 'no-colon-line\npasswd: files\n!bogus';
    const out = parseNsswitchConf(body);
    expect(out).toHaveLength(1);
    expect(out[0].database).toBe('passwd');
  });

  it('falls back to glibc defaults when the action map is silent', () => {
    const spec = { name: 'files', actions: {} };
    expect(effectiveAction(spec, 'SUCCESS')).toBe('return');
    expect(effectiveAction(spec, 'NOTFOUND')).toBe('continue');
    expect(effectiveAction(spec, 'UNAVAIL')).toBe('continue');
    expect(effectiveAction(spec, 'TRYAGAIN')).toBe('continue');
  });

  it('a `db files` ordering (services/protocols) is faithfully kept', () => {
    const out = parseNsswitchConf('services: db files');
    expect(out[0].sources.map(s => s.name)).toEqual(['db', 'files']);
  });
});

describe('NSS — lookup dispatch', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('exposes a NSS resolver on the executor', () => {
    expect(pc.executor.nss).toBeInstanceOf(NameServiceSwitch);
  });

  it('seeds /etc/nsswitch.conf on boot', () => {
    const content = pc.executor.vfs.readFile('/etc/nsswitch.conf');
    expect(content).toMatch(/passwd:\s+files/);
    expect(content).toMatch(/hosts:\s+files dns/);
  });

  it('seeds /etc/services with well-known ports', () => {
    expect(pc.executor.vfs.readFile('/etc/services')).toMatch(/ssh\s+22\/tcp/);
  });

  it('seeds /etc/protocols with IANA assignments', () => {
    expect(pc.executor.vfs.readFile('/etc/protocols')).toMatch(/^tcp\s+6\s+TCP/m);
  });

  it('returns SUCCESS for an existing user via passwd database', () => {
    const r = pc.executor.nss.lookup('passwd', s => s.getpwnam?.('root'));
    expect(r.status).toBe('SUCCESS');
    expect(r.entry?.uid).toBe(0);
  });

  it('returns NOTFOUND for an unknown user', () => {
    const r = pc.executor.nss.lookup('passwd', s => s.getpwnam?.('nosuch'));
    expect(r.status).toBe('NOTFOUND');
  });

  it('enumerates all passwd entries', () => {
    const r = pc.executor.nss.enumerate('passwd', s => s.enumPasswd?.());
    expect(r.status).toBe('SUCCESS');
    const names = r.entries.map(e => e.name);
    expect(names).toContain('root');
    expect(names).toContain('user');
  });

  it('respects [NOTFOUND=return] — does not fall through to next source', () => {
    // Force the config to: hosts files [NOTFOUND=return] dns
    pc.executor.vfs.writeFile(
      '/etc/nsswitch.conf',
      'hosts: files [NOTFOUND=return] dns\n',
      0, 0, 0o022,
    );
    const pc2 = new LinuxPC('pc2');
    pc2.setEventBus(bus);
    pc2.setHostname('pc2');
    // Without the override DNS would resolve pc2; [NOTFOUND=return] on
    // the `files` source short-circuits the chain after files said no.
    const r = pc.executor.nss.lookup('hosts', s => s.gethostbyname?.('pc2'));
    expect(r.status).toBe('NOTFOUND');
  });

  it('falls through `files NOTFOUND → dns SUCCESS` with default actions', () => {
    const pc2 = new LinuxPC('pc2');
    pc2.setEventBus(bus);
    pc2.setHostname('pc2'); // override the LINUX_PC_PROFILE default
    // Provision an IP on pc2 so the DNS source returns SUCCESS.
    const port = pc2.getPorts()[0];
    if (port) {
      pc2.configureInterface(
        port.getName(),
        new IPAddress('10.0.0.42'),
        new SubnetMask('255.255.255.0'),
      );
    }
    // Sanity probes: pc2 is registered, alive, and has the hostname.
    const all = EquipmentRegistry.getInstance().getAll();
    expect(all.some(d => d.getId() === pc2.getId())).toBe(true);
    expect(pc2.getIsPoweredOn()).toBe(true);
    expect(pc2.getHostname()).toBe('pc2');
    expect(port?.getIPAddress()?.toString()).toBe('10.0.0.42');

    // Files has no entry for pc2 (hostname is 'localhost' in /etc/hosts);
    // default action map: NOTFOUND=continue → DNS source consulted.
    const r = pc.executor.nss.lookup('hosts', s => s.gethostbyname?.('pc2'));
    expect(r.status).toBe('SUCCESS');
  });

  it('UNAVAIL when a declared source is not registered', () => {
    pc.executor.vfs.writeFile(
      '/etc/nsswitch.conf',
      'passwd: nis [UNAVAIL=return] files\n',
      0, 0, 0o022,
    );
    const r = pc.executor.nss.lookup('passwd', s => s.getpwnam?.('root'));
    expect(r.status).toBe('UNAVAIL');
  });
});

describe('NSS — reactive cache invalidation', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('IAM user.created → cache invalidation listener fires for "passwd"', () => {
    const invalidated: string[] = [];
    pc.executor.nss.onCacheInvalidated(db => invalidated.push(db));
    pc.executor.userMgr.useradd('zoe', {});
    expect(invalidated).toContain('passwd');
  });

  it('IAM user.password-changed → invalidates "shadow"', () => {
    const invalidated: string[] = [];
    pc.executor.userMgr.useradd('zoe', {});
    pc.executor.nss.onCacheInvalidated(db => invalidated.push(db));
    pc.executor.userMgr.setPassword('alice', 'newpass');
    expect(invalidated).toContain('shadow');
  });

  it('IAM group.membership-changed → invalidates "group"', () => {
    const invalidated: string[] = [];
    pc.executor.userMgr.useradd('zoe', {});
    pc.executor.userMgr.groupadd('devs');
    // Join alice to devs via gpasswd -M (member list reset). usermod -aG
    // would also fire `linux.iam.user.modified` but `group` isn't the
    // canonical signal for that route — we want the dedicated event.
    pc.executor.userMgr.gpasswd(['-M', 'alice', 'devs']);
    // Now remove her so the membership-changed event fires.
    pc.executor.nss.onCacheInvalidated(db => invalidated.push(db));
    pc.executor.userMgr.gpasswd(['-d', 'alice', 'devs']);
    expect(invalidated).toContain('group');
  });

  it('topology power-cycle → invalidates "hosts"', () => {
    const invalidated: string[] = [];
    const pc2 = new LinuxPC('pc2');
    pc2.setEventBus(bus);
    // Devices default to powered-on; an off→on transition is what
    // actually publishes the event, so toggle to force the bus signal.
    pc2.powerOff();
    pc.executor.nss.onCacheInvalidated(db => invalidated.push(db));
    pc2.powerOn();
    expect(invalidated).toContain('hosts');
  });

  it('dispose() unsubscribes from the bus', () => {
    const invalidated: string[] = [];
    pc.executor.nss.onCacheInvalidated(db => invalidated.push(db));
    pc.executor.nss.dispose();
    pc.executor.userMgr.useradd('zoe', {});
    // No more invalidations after dispose.
    expect(invalidated).toHaveLength(0);
  });
});

describe('NSS — FilesNssSource shadow privilege check', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('non-root reads of shadow return NOTFOUND', () => {
    // Default LinuxPC starts as 'user' (uid 1000), so shadow is denied.
    expect(pc.executor.userMgr.currentUid).toBe(1000);
    const r = pc.executor.nss.lookup('shadow', s => s.getspnam?.('root'));
    expect(r.status).toBe('NOTFOUND');
  });

  it('root reads of shadow succeed', () => {
    pc.executor.userMgr.currentUid = 0;
    pc.executor.userMgr.currentUser = 'root';
    const r = pc.executor.nss.lookup('shadow', s => s.getspnam?.('root'));
    expect(r.status).toBe('SUCCESS');
    expect(r.entry?.name).toBe('root');
  });
});

describe('NSS — DNS source', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('DNS source enumeration returns UNAVAIL (no infinite-domain walk)', () => {
    const dns = new DnsNssSource();
    const r = dns.enumHosts!();
    expect(r.status).toBe('UNAVAIL');
  });

  it('powered-off devices are excluded from gethostbyname', () => {
    const dns = new DnsNssSource();
    const pc2 = new LinuxPC('pc2');
    pc2.setEventBus(bus);
    pc2.setHostname('pc2');
    pc2.powerOff();
    const r = dns.gethostbyname!('pc2');
    expect(r.status).toBe('NOTFOUND');
  });
});

describe('NSS — files source initgroups', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('returns the user\'s primary GID + supplementary GIDs', () => {
    const r = pc.executor.nss.lookup<number[]>('initgroups', s => s.initgroups?.('user'));
    expect(r.status).toBe('SUCCESS');
    // Default LinuxPC user is in sudo + adm. Includes the primary 1000.
    expect(r.entry).toContain(1000);
  });
});

describe('NSS — files source factories', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('FilesNssSource parses /etc/services lines correctly', () => {
    const files = new FilesNssSource(pc.executor.vfs);
    const ssh = files.getservbyname!('ssh', 'tcp');
    expect(ssh.status).toBe('SUCCESS');
    expect(ssh.entry?.port).toBe(22);
    expect(ssh.entry?.protocol).toBe('tcp');
  });

  it('FilesNssSource parses /etc/protocols and resolves by number', () => {
    const files = new FilesNssSource(pc.executor.vfs);
    const tcp = files.getprotobynumber!(6);
    expect(tcp.status).toBe('SUCCESS');
    expect(tcp.entry?.name).toBe('tcp');
  });

  it('FilesNssSource enumerates /etc/passwd', () => {
    const files = new FilesNssSource(pc.executor.vfs);
    const all = files.enumPasswd!();
    expect(all.status).toBe('SUCCESS');
    expect(all.entries.some(e => e.name === 'root')).toBe(true);
    expect(all.entries.some(e => e.name === 'user')).toBe(true);
  });
});
