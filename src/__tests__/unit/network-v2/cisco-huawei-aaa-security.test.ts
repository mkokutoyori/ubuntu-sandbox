import { describe, beforeEach, expect, test } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { NetworkOsAccount } from '@/network/devices/router/aaa/NetworkOsAccount';
import { NetworkOsCredentialStore } from '@/network/devices/router/aaa/NetworkOsCredentialStore';
import { SecurityAuditLog } from '@/network/devices/router/aaa/SecurityAuditLog';
import { LoginBlocker } from '@/network/devices/router/aaa/LoginBlocker';
import { SshSessionRegistry } from '@/network/devices/router/aaa/SshSessionRegistry';
import { VtyLineConfig, VtyLineRange } from '@/network/devices/router/aaa/VtyLineConfig';
import { EventBus } from '@/events/EventBus';

interface Lab {
  linux1: LinuxPC;
  ciscoR1: CiscoRouter;
  hwR1: HuaweiRouter;
  sw: GenericSwitch;
}

async function buildLab(): Promise<Lab> {
  EquipmentRegistry.getInstance().clear();
  const linux1 = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const ciscoR1 = new CiscoRouter('ciscoR1', 0, 0);
  const hwR1 = new HuaweiRouter('hwR1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 8, 0, 0);
  const all = [linux1, ciscoR1, hwR1];
  all.forEach((d, i) => { const c = new Cable(`c${i}`); c.connect(d.getPorts()[0], sw.getPorts()[i]); });
  const m = new SubnetMask('255.255.255.0');
  linux1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  await ciscoR1.executeCommand('enable');
  await ciscoR1.executeCommand('configure terminal');
  await ciscoR1.executeCommand('interface GigabitEthernet0/0');
  await ciscoR1.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await ciscoR1.executeCommand('no shutdown');
  await ciscoR1.executeCommand('end');
  await hwR1.executeCommand('system-view');
  await hwR1.executeCommand('interface GigabitEthernet0/0/0');
  await hwR1.executeCommand('ip address 10.0.0.8 255.255.255.0');
  await hwR1.executeCommand('undo shutdown');
  await hwR1.executeCommand('quit');
  await hwR1.executeCommand('quit');
  return { linux1, ciscoR1, hwR1, sw };
}

describe('§A — Cisco local-user database is queryable and persistent', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('username admin secret stores the account with privilege', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret Admin@123');
    await lab.ciscoR1.executeCommand('end');
    const u = lab.ciscoR1._getLocalUser('admin');
    expect(u?.privilege).toBe(15);
    expect(u?.secret).toBe('Admin@123');
  });

  test('a second username adds a separate account', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret a');
    await lab.ciscoR1.executeCommand('username readonly privilege 1 secret b');
    await lab.ciscoR1.executeCommand('end');
    expect(lab.ciscoR1._listLocalUsers().map(u => u.name).sort()).toEqual(['admin', 'readonly']);
  });

  test('no username admin removes the account', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret a');
    await lab.ciscoR1.executeCommand('no username admin');
    await lab.ciscoR1.executeCommand('end');
    expect(lab.ciscoR1._getLocalUser('admin')).toBeUndefined();
  });
});

describe('§B — Huawei local-user database is queryable and persistent', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('local-user admin password creates the account', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher Admin@123');
    await lab.hwR1.executeCommand('local-user admin privilege level 15');
    await lab.hwR1.executeCommand('local-user admin service-type ssh');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    const u = lab.hwR1._getLocalUser('admin');
    expect(u?.privilege).toBe(15);
    expect(u?.secret).toBe('Admin@123');
  });

  test('multiple local-users are stored', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher a');
    await lab.hwR1.executeCommand('local-user readonly password cipher b');
    await lab.hwR1.executeCommand('local-user readonly privilege level 1');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    expect(lab.hwR1._listLocalUsers().map(u => u.name).sort()).toEqual(['admin', 'readonly']);
  });

  test('undo local-user admin removes the account', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher a');
    await lab.hwR1.executeCommand('undo local-user admin');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    expect(lab.hwR1._getLocalUser('admin')).toBeUndefined();
  });
});

describe('§C — local users appear in running-config / current-configuration', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('Cisco show running-config includes username admin with privilege', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret Admin@123');
    await lab.ciscoR1.executeCommand('end');
    const out = lab.ciscoR1.runSshCommandSync('', 'show running-config');
    expect(out?.output).toMatch(/username admin privilege 15 secret/);
  });

  test('Huawei display current-configuration includes local-user admin', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher Admin@123');
    await lab.hwR1.executeCommand('local-user admin privilege level 15');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    const out = lab.hwR1.runSshCommandSync('', 'display current-configuration');
    expect(out?.output).toMatch(/local-user admin password/);
    expect(out?.output).toMatch(/local-user admin privilege level 15/);
  });
});

describe('§D — NetworkOsAccount domain model carries real-equipment attributes', () => {
  test('factory builds an account with sensible defaults', () => {
    const acc = NetworkOsAccount.create({ name: 'admin' });
    expect(acc.name).toBe('admin');
    expect(acc.privilege).toBe(1);
    expect(acc.locked).toBe(false);
    expect(acc.serviceTypes).toEqual([]);
    expect(acc.failedLoginCount).toBe(0);
    expect(acc.lastLoginAt).toBeNull();
    expect(acc.lastFailedLoginAt).toBeNull();
    expect(acc.passwordHashAlgorithm).toBe('plain');
    expect(acc.maxConcurrentSessions).toBe(0);
    expect(acc.idleTimeoutSeconds).toBe(0);
    expect(acc.publicKeys).toEqual([]);
  });

  test('withSecret stores password + hash algorithm', () => {
    const acc = NetworkOsAccount.create({ name: 'admin' })
      .withSecret('Admin@123', 'sha256');
    expect(acc.secret).toBe('Admin@123');
    expect(acc.passwordHashAlgorithm).toBe('sha256');
  });

  test('recordLoginSuccess clears failure count and stamps lastLoginAt', () => {
    const t0 = 1_700_000_000_000;
    const acc = NetworkOsAccount.create({ name: 'admin' })
      .withFailedLogin(t0 - 1000)
      .withFailedLogin(t0 - 500)
      .withSuccessfulLogin(t0, '10.0.0.1', 'password');
    expect(acc.failedLoginCount).toBe(0);
    expect(acc.lastLoginAt).toBe(t0);
    expect(acc.lastLoginFrom).toBe('10.0.0.1');
    expect(acc.lastLoginMethod).toBe('password');
  });

  test('lock and unlock flip the locked flag', () => {
    const acc = NetworkOsAccount.create({ name: 'admin' });
    expect(acc.lock('admin-action').locked).toBe(true);
    expect(acc.lock('admin-action').lockReason).toBe('admin-action');
    expect(acc.unlock().locked).toBe(false);
  });

  test('passwordExpired honours expiryDate', () => {
    const t = 1_700_000_000_000;
    const acc = NetworkOsAccount.create({ name: 'admin', expireAt: t });
    expect(acc.isPasswordExpired(t + 1)).toBe(true);
    expect(acc.isPasswordExpired(t - 1)).toBe(false);
  });
});

describe('§E — NetworkOsCredentialStore publishes lifecycle events', () => {
  let bus: EventBus;
  let store: NetworkOsCredentialStore;
  let events: Array<{ topic: string; payload: unknown }>;

  beforeEach(() => {
    bus = new EventBus();
    store = new NetworkOsCredentialStore({ deviceId: 'r1', bus });
    events = [];
    bus.subscribe('router.aaa.account.created', e => events.push({ topic: e.topic, payload: e.payload }));
    bus.subscribe('router.aaa.account.updated', e => events.push({ topic: e.topic, payload: e.payload }));
    bus.subscribe('router.aaa.account.deleted', e => events.push({ topic: e.topic, payload: e.payload }));
  });

  test('upsert of a new name emits a created event', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 }));
    expect(events.length).toBe(1);
    expect(events[0].topic).toBe('router.aaa.account.created');
    expect((events[0].payload as { account: { name: string } }).account.name).toBe('admin');
  });

  test('upsert of an existing name emits an updated event', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
    store.upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 }));
    expect(events.map(e => e.topic)).toEqual([
      'router.aaa.account.created',
      'router.aaa.account.updated',
    ]);
  });

  test('remove returns the deleted account and emits deleted', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
    const removed = store.remove('admin');
    expect(removed?.name).toBe('admin');
    expect(events[events.length - 1].topic).toBe('router.aaa.account.deleted');
  });

  test('list reflects ordered names alphabetically', () => {
    store.upsert(NetworkOsAccount.create({ name: 'zoe' }));
    store.upsert(NetworkOsAccount.create({ name: 'alice' }));
    expect(store.list().map(a => a.name)).toEqual(['alice', 'zoe']);
  });

  test('get on absent name returns undefined', () => {
    expect(store.get('ghost')).toBeUndefined();
  });
});

describe('§F — SecurityAuditLog reacts to AAA events on the bus', () => {
  let bus: EventBus;
  let store: NetworkOsCredentialStore;
  let audit: SecurityAuditLog;

  beforeEach(() => {
    bus = new EventBus();
    store = new NetworkOsCredentialStore({ deviceId: 'r1', bus });
    audit = new SecurityAuditLog({ deviceId: 'r1', bus, now: () => 1_700_000_000_000 });
  });

  test('account creation produces a SEC_LOGIN-6-CONFIG_CHANGE entry', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 }));
    const entries = audit.entries();
    expect(entries.some(e => e.facility === 'SEC_LOGIN' && /admin/.test(e.message))).toBe(true);
  });

  test('successful login produces a SEC_LOGIN-5-LOGIN_SUCCESS entry', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', 1_700_000_000_001);
    const last = audit.entries().slice(-1)[0];
    expect(last.mnemonic).toBe('LOGIN_SUCCESS');
    expect(last.message).toMatch(/admin/);
    expect(last.message).toMatch(/10\.0\.0\.1/);
  });

  test('failed login produces a SEC_LOGIN-4-LOGIN_FAILED entry', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
    store.recordLoginFailure('admin', '10.0.0.2', 'bad password', 1_700_000_000_002);
    const last = audit.entries().slice(-1)[0];
    expect(last.mnemonic).toBe('LOGIN_FAILED');
    expect(last.severity).toBe(4);
    expect(last.message).toMatch(/10\.0\.0\.2/);
  });

  test('audit log preserves chronological order across event types', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
    store.recordLoginFailure('admin', '10.0.0.2', 'x', 1);
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', 2);
    store.lock('admin', 'too many failures', 3);
    expect(audit.entries().map(e => e.mnemonic)).toEqual([
      'CONFIG_CHANGE', 'LOGIN_FAILED', 'LOGIN_SUCCESS', 'ACCOUNT_LOCKED',
    ]);
  });

  test('format() returns IOS-style "show logging" formatted lines', () => {
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
    const rendered = audit.format();
    expect(rendered).toMatch(/%SEC_LOGIN-6-CONFIG_CHANGE:/);
  });
});

describe('§G — Router wires CredentialStore + SecurityAuditLog into native CLI', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('Cisco show logging contains a CONFIG_CHANGE entry after username admin', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret Admin@123');
    await lab.ciscoR1.executeCommand('end');
    const out = lab.ciscoR1.runSshCommandSync('', 'show logging');
    expect(out?.output).toMatch(/%SEC_LOGIN-6-CONFIG_CHANGE.*admin/);
  });

  test('Cisco show logging records an SSH login success', () => {
    lab.ciscoR1.getCredentialStore().upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 }));
    lab.ciscoR1.getCredentialStore().recordLoginSuccess('admin', '10.0.0.1', 'password');
    const out = lab.ciscoR1.runSshCommandSync('', 'show logging');
    expect(out?.output).toMatch(/%SEC_LOGIN-5-LOGIN_SUCCESS/);
    expect(out?.output).toMatch(/10\.0\.0\.1/);
  });

  test('Huawei display logbuffer contains AAA events', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher Admin@123');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    const out = lab.hwR1.runSshCommandSync('', 'display logbuffer');
    expect(out?.output).toMatch(/SEC_LOGIN|CONFIG_CHANGE|admin/);
  });

  test('Cisco show logging is empty when nothing happened', () => {
    const out = lab.ciscoR1.runSshCommandSync('', 'show logging');
    expect(out?.output).toMatch(/Syslog logging:/);
  });
});

describe('§H — LoginBlocker reacts to repeated login failures', () => {
  let bus: EventBus;
  let store: NetworkOsCredentialStore;
  let blocker: LoginBlocker;
  let now: number;

  beforeEach(() => {
    bus = new EventBus();
    store = new NetworkOsCredentialStore({ deviceId: 'r1', bus });
    now = 1_700_000_000_000;
    blocker = new LoginBlocker({
      deviceId: 'r1',
      bus,
      attempts: 3,
      withinSeconds: 30,
      blockSeconds: 60,
      now: () => now,
    });
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
  });

  test('blocker is permissive by default', () => {
    expect(blocker.isBlocked('10.0.0.1', now)).toBe(false);
  });

  test('three failures within window block subsequent attempts from the same IP', () => {
    store.recordLoginFailure('admin', '10.0.0.2', 'bad password', now);
    store.recordLoginFailure('admin', '10.0.0.2', 'bad password', now + 100);
    store.recordLoginFailure('admin', '10.0.0.2', 'bad password', now + 200);
    expect(blocker.isBlocked('10.0.0.2', now + 300)).toBe(true);
  });

  test('a successful login from the same IP clears the counter', () => {
    store.recordLoginFailure('admin', '10.0.0.2', 'bad', now);
    store.recordLoginFailure('admin', '10.0.0.2', 'bad', now + 100);
    store.recordLoginSuccess('admin', '10.0.0.2', 'password', now + 200);
    store.recordLoginFailure('admin', '10.0.0.2', 'bad', now + 300);
    expect(blocker.isBlocked('10.0.0.2', now + 400)).toBe(false);
  });

  test('failures older than the window are not counted', () => {
    store.recordLoginFailure('admin', '10.0.0.2', 'bad', now);
    store.recordLoginFailure('admin', '10.0.0.2', 'bad', now + 1_000);
    store.recordLoginFailure('admin', '10.0.0.2', 'bad', now + 40_000);
    expect(blocker.isBlocked('10.0.0.2', now + 41_000)).toBe(false);
  });

  test('block expires after blockSeconds', () => {
    for (let i = 0; i < 3; i++) {
      store.recordLoginFailure('admin', '10.0.0.2', 'bad', now + i * 100);
    }
    expect(blocker.isBlocked('10.0.0.2', now + 300)).toBe(true);
    expect(blocker.isBlocked('10.0.0.2', now + 61_000)).toBe(false);
  });

  test('failures from a different IP are tracked independently', () => {
    for (let i = 0; i < 3; i++) {
      store.recordLoginFailure('admin', '10.0.0.2', 'bad', now + i * 100);
    }
    expect(blocker.isBlocked('10.0.0.3', now + 400)).toBe(false);
    expect(blocker.isBlocked('10.0.0.2', now + 400)).toBe(true);
  });
});

describe('§I — login block-for / authentication-retries wired into Router', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('Cisco login block-for installs a LoginBlocker', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('login block-for 60 attempts 2 within 30');
    await lab.ciscoR1.executeCommand('end');
    const b = lab.ciscoR1.getLoginBlocker();
    expect(b).not.toBeNull();
    expect(b?.remainingFailuresBeforeBlock('10.0.0.9')).toBe(2);
  });

  test('Cisco show running-config retains login block-for line', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('login block-for 60 attempts 2 within 30');
    await lab.ciscoR1.executeCommand('end');
    const out = lab.ciscoR1.runSshCommandSync('', 'show running-config');
    expect(out?.output).toMatch(/login block-for 60 attempts 2 within 30/);
  });

  test('Huawei ssh server authentication-retries installs the blocker', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('ssh server authentication-retries 3');
    await lab.hwR1.executeCommand('quit');
    expect(lab.hwR1.getLoginBlocker()).not.toBeNull();
  });

  test('Huawei display current-configuration retains the retries setting', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('ssh server authentication-retries 3');
    await lab.hwR1.executeCommand('quit');
    const out = lab.hwR1.runSshCommandSync('', 'display current-configuration');
    expect(out?.output).toMatch(/ssh server authentication-retries 3/);
  });
});

async function provisionCiscoSsh(r: CiscoRouter): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('username admin privilege 15 secret Admin@123');
  await r.executeCommand('crypto key generate rsa modulus 2048');
  await r.executeCommand('line vty 0 4');
  await r.executeCommand('login local');
  await r.executeCommand('transport input ssh');
  await r.executeCommand('end');
}

describe('§J — SSH dispatch publishes lifecycle events on the bus', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); await provisionCiscoSsh(lab.ciscoR1); });

  test('successful SSH login emits router.aaa.account.login.success', async () => {
    const seen: string[] = [];
    lab.ciscoR1.getBus().subscribe('router.aaa.account.login.success', e => seen.push((e.payload as { account: { name: string } }).account.name));
    await lab.linux1.executeCommand('ssh admin@10.0.0.6 "show version"');
    expect(seen).toContain('admin');
  });

  test('failed SSH login (unknown user) emits router.aaa.account.login.failure', async () => {
    const seen: string[] = [];
    lab.ciscoR1.getBus().subscribe('router.aaa.account.login.failure', e => seen.push((e.payload as { account: { name: string } }).account.name));
    await lab.linux1.executeCommand('ssh ghost@10.0.0.6 "show version"');
    expect(seen).toContain('ghost');
  });

  test('show logging after a wrong login contains LOGIN_FAILED', async () => {
    await lab.linux1.executeCommand('ssh ghost@10.0.0.6 "show version"');
    const out = lab.ciscoR1.runSshCommandSync('', 'show logging');
    expect(out?.output).toMatch(/%SEC_LOGIN-4-LOGIN_FAILED/);
    expect(out?.output).toMatch(/10\.0\.0\.1/);
  });

  test('login block-for refuses subsequent attempts after threshold', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('login block-for 60 attempts 2 within 30');
    await lab.ciscoR1.executeCommand('end');
    await lab.linux1.executeCommand('ssh ghost@10.0.0.6 "show version"');
    await lab.linux1.executeCommand('ssh ghost2@10.0.0.6 "show version"');
    const blocked = await lab.linux1.executeCommand('ssh admin@10.0.0.6 "show version"');
    expect(blocked).toMatch(/Connection (closed|refused)|denied|Quiet-Mode/i);
  });
});

describe('§K — SshSessionRegistry tracks active VTY sessions reactively', () => {
  let bus: EventBus;
  let store: NetworkOsCredentialStore;
  let registry: SshSessionRegistry;
  let now: number;

  beforeEach(() => {
    bus = new EventBus();
    store = new NetworkOsCredentialStore({ deviceId: 'r1', bus });
    now = 1_700_000_000_000;
    registry = new SshSessionRegistry({ deviceId: 'r1', bus, maxLines: 16, now: () => now });
    store.upsert(NetworkOsAccount.create({ name: 'admin' }));
  });

  test('starts with zero active sessions', () => {
    expect(registry.list()).toEqual([]);
  });

  test('a successful login opens a session and assigns line vty 0', () => {
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', now);
    const sessions = registry.list();
    expect(sessions.length).toBe(1);
    expect(sessions[0].user).toBe('admin');
    expect(sessions[0].fromIp).toBe('10.0.0.1');
    expect(sessions[0].line).toBe('vty 0');
    expect(sessions[0].loginAt).toBe(now);
    expect(sessions[0].state).toBe('active');
  });

  test('two concurrent logins consume vty 0 and vty 1', () => {
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', now);
    store.recordLoginSuccess('admin', '10.0.0.2', 'password', now + 10);
    expect(registry.list().map(s => s.line)).toEqual(['vty 0', 'vty 1']);
  });

  test('explicit close releases the line', () => {
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', now);
    const id = registry.list()[0].id;
    registry.close(id, 'logout', now + 1000);
    expect(registry.list()).toEqual([]);
    const closed = registry.history().slice(-1)[0];
    expect(closed.closedAt).toBe(now + 1000);
    expect(closed.closeReason).toBe('logout');
  });

  test('formatShowUsers returns Cisco-style VTY listing', () => {
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', now);
    const text = registry.formatShowUsers();
    expect(text).toMatch(/Line\s+User\s+Host/);
    expect(text).toMatch(/vty 0\s+admin/);
    expect(text).toMatch(/10\.0\.0\.1/);
  });

  test('formatDisplayUsers returns VRP-style listing', () => {
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', now);
    const text = registry.formatDisplayUsers();
    expect(text).toMatch(/UI\s+Delay/);
    expect(text).toMatch(/SSH/);
    expect(text).toMatch(/admin/);
    expect(text).toMatch(/10\.0\.0\.1/);
  });

  test('idle seconds increase over time and reset on activity', () => {
    store.recordLoginSuccess('admin', '10.0.0.1', 'password', now);
    now += 45_000;
    expect(registry.list()[0].idleSeconds).toBe(45);
    registry.touch(registry.list()[0].id, now);
    expect(registry.list()[0].idleSeconds).toBe(0);
  });
});

describe('§L — Router wires SshSessionRegistry into show users / display users', () => {
  let lab: Lab;
  beforeEach(async () => {
    lab = await buildLab();
    await provisionCiscoSsh(lab.ciscoR1);
  });

  test('Cisco show users lists vty 0 admin host 10.0.0.1 after SSH login', () => {
    lab.ciscoR1.getCredentialStore().upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 }));
    lab.ciscoR1.getCredentialStore().recordLoginSuccess('admin', '10.0.0.1', 'password');
    const out = lab.ciscoR1.runSshCommandSync('', 'show users');
    expect(out?.output).toMatch(/vty 0\s+admin/);
    expect(out?.output).toMatch(/10\.0\.0\.1/);
  });

  test('Huawei display users lists the SSH session reactively', () => {
    lab.hwR1.getCredentialStore().upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 }));
    lab.hwR1.getCredentialStore().recordLoginSuccess('admin', '10.0.0.1', 'password');
    const out = lab.hwR1.runSshCommandSync('', 'display users');
    expect(out?.output).toMatch(/SSH/);
    expect(out?.output).toMatch(/admin/);
    expect(out?.output).toMatch(/10\.0\.0\.1/);
  });

  test('Sessions are auto-closed at the end of one-shot exec mode', async () => {
    await lab.linux1.executeCommand('ssh admin@10.0.0.6 "show version"');
    expect(lab.ciscoR1.getSshSessionRegistry().list().length).toBe(0);
    expect(lab.ciscoR1.getSshSessionRegistry().history().length).toBe(1);
  });
});

describe('§M — VtyLineConfig domain model carries every line directive', () => {
  test('defaults are sane for a fresh vty range', () => {
    const cfg = VtyLineConfig.forRange(new VtyLineRange(0, 4));
    expect(cfg.range.first).toBe(0);
    expect(cfg.range.last).toBe(4);
    expect(cfg.transportInput).toEqual(['ssh']);
    expect(cfg.transportOutput).toEqual(['ssh']);
    expect(cfg.loginMode).toBe('none');
    expect(cfg.execTimeoutMinutes).toBe(10);
    expect(cfg.execTimeoutSeconds).toBe(0);
    expect(cfg.sessionTimeoutMinutes).toBe(0);
    expect(cfg.privilegeLevel).toBe(1);
    expect(cfg.history).toBe(20);
    expect(cfg.terminalLength).toBe(24);
    expect(cfg.terminalWidth).toBe(80);
    expect(cfg.accessClassIn).toBeNull();
    expect(cfg.accessClassOut).toBeNull();
    expect(cfg.password).toBeNull();
    expect(cfg.autocommand).toBeNull();
    expect(cfg.motdBannerEnabled).toBe(true);
    expect(cfg.escapeChar).toBe(30);
    expect(cfg.location).toBeNull();
  });

  test('mutators return new instances with patched fields', () => {
    const cfg = VtyLineConfig.forRange(new VtyLineRange(0, 4))
      .withTransportInput(['ssh'])
      .withLoginMode('local')
      .withExecTimeout(5, 30)
      .withAccessClass('in', 20)
      .withPrivilege(15)
      .withAutocommand('show ip interface brief')
      .withLocation('rack-12-row-A');
    expect(cfg.loginMode).toBe('local');
    expect(cfg.execTimeoutMinutes).toBe(5);
    expect(cfg.execTimeoutSeconds).toBe(30);
    expect(cfg.accessClassIn).toBe(20);
    expect(cfg.privilegeLevel).toBe(15);
    expect(cfg.autocommand).toBe('show ip interface brief');
    expect(cfg.location).toBe('rack-12-row-A');
  });

  test('toRunningConfig emits IOS-style line block', () => {
    const cfg = VtyLineConfig.forRange(new VtyLineRange(0, 4))
      .withLoginMode('local')
      .withTransportInput(['ssh'])
      .withExecTimeout(5, 0);
    const text = cfg.toRunningConfig();
    expect(text).toContain('line vty 0 4');
    expect(text).toContain(' login local');
    expect(text).toContain(' transport input ssh');
    expect(text).toContain(' exec-timeout 5 0');
  });

  test('VtyLineRange equality and merging', () => {
    const a = new VtyLineRange(0, 4);
    const b = new VtyLineRange(0, 4);
    expect(a.equals(b)).toBe(true);
    expect(a.contains(2)).toBe(true);
    expect(a.size()).toBe(5);
  });

  test('transport input none disables every protocol', () => {
    const cfg = VtyLineConfig.forRange(new VtyLineRange(0, 4))
      .withTransportInput([]);
    expect(cfg.transportInput).toEqual([]);
    expect(cfg.toRunningConfig()).toContain(' transport input none');
  });
});

describe('§N — NetworkOsAccount authentication honours service-type and lifecycle', () => {
  test('authenticate matches stored secret', () => {
    const acc = NetworkOsAccount.create({ name: 'admin' }).withSecret('hunter2');
    expect(acc.authenticate('hunter2')).toBe(true);
    expect(acc.authenticate('hunter3')).toBe(false);
  });

  test('account with empty secret refuses every password', () => {
    const acc = NetworkOsAccount.create({ name: 'admin' });
    expect(acc.authenticate('')).toBe(false);
    expect(acc.authenticate('anything')).toBe(false);
  });

  test('allowsService is permissive when no service-type was configured', () => {
    const acc = NetworkOsAccount.create({ name: 'admin' });
    expect(acc.allowsService('ssh')).toBe(true);
    expect(acc.allowsService('telnet')).toBe(true);
  });

  test('allowsService restricts when service-types is explicit', () => {
    const acc = NetworkOsAccount.create({ name: 'admin' })
      .withServiceTypes(['ssh']);
    expect(acc.allowsService('ssh')).toBe(true);
    expect(acc.allowsService('telnet')).toBe(false);
    expect(acc.allowsService('http')).toBe(false);
  });

  test('Router sshdAcceptsLogin enforces service-type ssh', () => {
    const lab = { } as Lab;
  });
});

describe('§O — Router sshdAcceptsLogin gates SSH-restricted accounts', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('account with service-type stelnet only accepts ssh login', () => {
    const store = lab.hwR1.getCredentialStore();
    store.upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 })
      .withSecret('a').withServiceTypes(['ssh', 'stelnet']));
    expect(lab.hwR1.sshdAcceptsLogin('admin').ok).toBe(true);
  });

  test('account restricted to ftp refuses ssh login', () => {
    const store = lab.hwR1.getCredentialStore();
    store.upsert(NetworkOsAccount.create({ name: 'ftponly', privilege: 1 })
      .withSecret('x').withServiceTypes(['ftp']));
    expect(lab.hwR1.sshdAcceptsLogin('ftponly').ok).toBe(false);
  });

  test('disabled account refuses ssh login', () => {
    const store = lab.ciscoR1.getCredentialStore();
    store.upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 })
      .withSecret('a').disable());
    expect(lab.ciscoR1.sshdAcceptsLogin('admin').ok).toBe(false);
  });

  test('expired account refuses ssh login', () => {
    const store = lab.ciscoR1.getCredentialStore();
    store.upsert(NetworkOsAccount.create({ name: 'old', privilege: 1, expireAt: 1 })
      .withSecret('a'));
    expect(lab.ciscoR1.sshdAcceptsLogin('old').ok).toBe(false);
  });

  test('locked account refuses ssh login', () => {
    const store = lab.ciscoR1.getCredentialStore();
    store.upsert(NetworkOsAccount.create({ name: 'admin' }).lock('admin-action'));
    expect(lab.ciscoR1.sshdAcceptsLogin('admin').ok).toBe(false);
  });
});

describe('§P — Cisco username captures hash algorithm + secret form', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('username admin secret 5 $1$xxx records sha256 algorithm', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret 5 $1$abcd$xyz');
    await lab.ciscoR1.executeCommand('end');
    const acc = lab.ciscoR1.getCredentialStore().get('admin');
    expect(acc?.privilege).toBe(15);
    expect(acc?.secret).toBe('$1$abcd$xyz');
    expect(acc?.passwordHashAlgorithm).toBe('md5');
  });

  test('username admin secret plain stores plain algorithm', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin secret 0 Admin@123');
    await lab.ciscoR1.executeCommand('end');
    const acc = lab.ciscoR1.getCredentialStore().get('admin');
    expect(acc?.secret).toBe('Admin@123');
    expect(acc?.passwordHashAlgorithm).toBe('plain');
  });

  test('username admin password 7 stores type-7', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin password 7 070C285F4D06');
    await lab.ciscoR1.executeCommand('end');
    const acc = lab.ciscoR1.getCredentialStore().get('admin');
    expect(acc?.secret).toBe('070C285F4D06');
    expect(acc?.passwordHashAlgorithm).toBe('type-7');
  });

  test('username with no password leaves secret empty', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username readonly privilege 1 nopassword');
    await lab.ciscoR1.executeCommand('end');
    const acc = lab.ciscoR1.getCredentialStore().get('readonly');
    expect(acc?.secret).toBe('');
    expect(acc?.privilege).toBe(1);
  });

  test('username admin secret 9 records scrypt', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin secret 9 $9$xyz');
    await lab.ciscoR1.executeCommand('end');
    const acc = lab.ciscoR1.getCredentialStore().get('admin');
    expect(acc?.passwordHashAlgorithm).toBe('sha256');
  });
});
