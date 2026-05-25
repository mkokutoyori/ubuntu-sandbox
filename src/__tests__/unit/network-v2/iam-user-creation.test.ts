/**
 * IAM / user creation — unit tests.
 *
 * Pins the faithful behaviour of the two account-creation commands:
 *
 *   - `useradd` — the low-level, NON-interactive command. It must never
 *     drive a password / GECOS flow; it simply creates the account.
 *   - `adduser` — the Debian/Ubuntu front-end. It is interactive for a
 *     plain user creation, and is overloaded over create-user /
 *     add-to-group / create-group.
 *
 * Coverage:
 *   - GecosInfo value object (parse / render / round-trip / edge cases)
 *   - useradd & adduser option parsers
 *   - LinuxUserAccount / LinuxGroup domain entities
 *   - LinuxFlowBuilder: useradd never interactive, adduser interactive
 *     only for a plain creation
 *   - LinuxUserManager + reactive IAM domain events
 *   - Executor-level `adduser` / `addgroup` faithful output
 *
 * The Playwright suite (`e2e/user-creation.spec.ts`) exercises the same
 * behaviour from the real terminal UI.
 */

import { describe, it, expect, vi } from 'vitest';
import { GecosInfo } from '@/network/devices/linux/iam/GecosInfo';
import {
  LinuxUserAccount,
  daysSinceEpoch,
} from '@/network/devices/linux/iam/LinuxUserAccount';
import { LinuxGroup } from '@/network/devices/linux/iam/LinuxGroup';
import { parseUseraddArgs } from '@/network/devices/linux/iam/useraddOptions';
import { parseAdduserArgs } from '@/network/devices/linux/iam/adduserOptions';
import { LinuxFlowBuilder } from '@/terminal/flows/LinuxFlowBuilder';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import type { InteractiveStep } from '@/terminal/core/types';

// ═══════════════════════════════════════════════════════════════════
// GecosInfo
// ═══════════════════════════════════════════════════════════════════

describe('GecosInfo', () => {
  it('parses an empty string into the canonical empty record', () => {
    expect(GecosInfo.parse('')).toBe(GecosInfo.EMPTY);
  });

  it('parses the five conventional sub-fields', () => {
    const g = GecosInfo.parse('Bob Martin,101,555-1,555-2,note');
    expect(g.fullName).toBe('Bob Martin');
    expect(g.roomNumber).toBe('101');
    expect(g.workPhone).toBe('555-1');
    expect(g.homePhone).toBe('555-2');
    expect(g.other).toBe('note');
  });

  it('always renders five comma-separated fields, keeping trailing empties', () => {
    expect(new GecosInfo('Marie Martin', '202').toString()).toBe('Marie Martin,202,,,');
  });

  it('folds extra commas back into the Other field (lossless round-trip)', () => {
    const raw = 'Name,Room,Work,Home,a,b,c';
    expect(GecosInfo.parse(raw).other).toBe('a,b,c');
    expect(GecosInfo.parse(raw).toString()).toBe(raw);
  });

  it('preserves unicode and accented characters', () => {
    const g = GecosInfo.parse('Jean Dupré,Bureau 3,,,résumé 🚀');
    expect(g.fullName).toBe('Jean Dupré');
    expect(g.other).toBe('résumé 🚀');
  });

  it('reports emptiness correctly', () => {
    expect(GecosInfo.EMPTY.isEmpty()).toBe(true);
    expect(new GecosInfo('x').isEmpty()).toBe(false);
  });

  it('compares structurally with equals', () => {
    expect(new GecosInfo('a', 'b').equals(new GecosInfo('a', 'b'))).toBe(true);
    expect(new GecosInfo('a').equals(new GecosInfo('b'))).toBe(false);
  });

  it('mutators return a new instance and leave the original untouched', () => {
    const original = new GecosInfo('Old');
    const updated = original.withFullName('New');
    expect(original.fullName).toBe('Old');
    expect(updated.fullName).toBe('New');
    expect(updated).not.toBe(original);
  });
});

// ═══════════════════════════════════════════════════════════════════
// useradd option parser
// ═══════════════════════════════════════════════════════════════════

describe('parseUseraddArgs', () => {
  it('extracts the username as the trailing bare token', () => {
    expect(parseUseraddArgs(['alice']).username).toBe('alice');
    expect(parseUseraddArgs(['-m', '-s', '/bin/bash', 'alice']).username).toBe('alice');
  });

  it('returns an empty username when none is supplied', () => {
    expect(parseUseraddArgs([]).username).toBe('');
    expect(parseUseraddArgs(['-m']).username).toBe('');
  });

  it('parses short boolean and value flags', () => {
    const req = parseUseraddArgs([
      '-m', '-r', '-o', '-u', '1500', '-g', 'staff',
      '-G', 'sudo,adm', '-s', '/bin/zsh', '-c', 'Jo Bloggs', '-p', 'HASH', 'jo',
    ]);
    expect(req.createHome).toBe(true);
    expect(req.systemAccount).toBe(true);
    expect(req.nonUnique).toBe(true);
    expect(req.uid).toBe(1500);
    expect(req.primaryGroup).toBe('staff');
    expect(req.supplementaryGroups).toEqual(['sudo', 'adm']);
    expect(req.shell).toBe('/bin/zsh');
    expect(req.comment).toBe('Jo Bloggs');
    expect(req.passwordHash).toBe('HASH');
    expect(req.username).toBe('jo');
  });

  it('parses long-form and --opt=value options', () => {
    const req = parseUseraddArgs(['--create-home', '--system', '--comment=Big Name', '--uid=2000', 'x']);
    expect(req.createHome).toBe(true);
    expect(req.systemAccount).toBe(true);
    expect(req.comment).toBe('Big Name');
    expect(req.uid).toBe(2000);
  });

  it('ignores a non-numeric UID rather than throwing', () => {
    expect(parseUseraddArgs(['-u', 'abc', 'x']).uid).toBeUndefined();
  });

  it('drops empty entries from a supplementary group list', () => {
    expect(parseUseraddArgs(['-G', 'sudo,,adm,', 'x']).supplementaryGroups)
      .toEqual(['sudo', 'adm']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// adduser option parser
// ═══════════════════════════════════════════════════════════════════

describe('parseAdduserArgs', () => {
  it('resolves a single name to the create-user mode', () => {
    const req = parseAdduserArgs(['bob']);
    expect(req.mode).toBe('create-user');
    expect(req.name).toBe('bob');
  });

  it('resolves two positionals to the add-to-group mode', () => {
    const req = parseAdduserArgs(['bob', 'sudo']);
    expect(req.mode).toBe('add-to-group');
    expect(req.name).toBe('bob');
    expect(req.group).toBe('sudo');
  });

  it('resolves --group to the create-group mode', () => {
    expect(parseAdduserArgs(['--group', 'dev']).mode).toBe('create-group');
  });

  it('treats the addgroup alias as create-group', () => {
    const req = parseAdduserArgs(['dev'], true);
    expect(req.mode).toBe('create-group');
    expect(req.name).toBe('dev');
  });

  it('parses --system', () => {
    expect(parseAdduserArgs(['--system', 'svc']).system).toBe(true);
  });

  it('parses the value options', () => {
    const req = parseAdduserArgs([
      '--uid', '1500', '--gid', '60', '--ingroup', 'staff',
      '--home', '/srv/bob', '--shell', '/bin/zsh', '--gecos', 'Bob Martin', 'bob',
    ]);
    expect(req.uid).toBe(1500);
    expect(req.gid).toBe(60);
    expect(req.ingroup).toBe('staff');
    expect(req.home).toBe('/srv/bob');
    expect(req.shell).toBe('/bin/zsh');
    expect(req.gecos).toBe('Bob Martin');
  });

  it('parses --disabled-password and --no-create-home', () => {
    const req = parseAdduserArgs(['--disabled-password', '--no-create-home', 'svc']);
    expect(req.disabledPassword).toBe(true);
    expect(req.noCreateHome).toBe(true);
  });

  it('treats --disabled-login as disabling the password', () => {
    expect(parseAdduserArgs(['--disabled-login', 'svc']).disabledPassword).toBe(true);
  });

  it('parses the --opt=value long form', () => {
    expect(parseAdduserArgs(['--gecos=Auto User', 'x']).gecos).toBe('Auto User');
  });
});

// ═══════════════════════════════════════════════════════════════════
// LinuxUserAccount / LinuxGroup
// ═══════════════════════════════════════════════════════════════════

describe('LinuxUserAccount', () => {
  const baseInit = { username: 'bob', uid: 1001, gid: 1001, home: '/home/bob', shell: '/bin/bash' };

  it('renders an /etc/passwd line', () => {
    const acc = new LinuxUserAccount({ ...baseInit, gecos: 'Bob Martin' });
    expect(acc.toPasswdLine()).toBe('bob:x:1001:1001:Bob Martin:/home/bob:/bin/bash');
  });

  it('renders an /etc/shadow line and marks locked accounts', () => {
    const acc = new LinuxUserAccount({ ...baseInit, password: 'HASH', lastChange: 100 });
    expect(acc.toShadowLine()).toBe('bob:HASH:100:0:99999:7:::');
    acc.lock();
    expect(acc.toShadowLine().startsWith('bob:!HASH:')).toBe(true);
  });

  it('classifies a high-UID account as regular and a low-UID one as system', () => {
    expect(new LinuxUserAccount({ ...baseInit }).kind).toBe('regular');
    expect(new LinuxUserAccount({ ...baseInit, uid: 5 }).kind).toBe('system');
  });

  it('exposes a structured GECOS view that round-trips through the raw field', () => {
    const acc = new LinuxUserAccount({ ...baseInit });
    acc.gecosInfo = new GecosInfo('Bob', '101');
    expect(acc.gecos).toBe('Bob,101,,,');
    expect(acc.gecosInfo.fullName).toBe('Bob');
  });

  it('detects a disabled login shell', () => {
    expect(new LinuxUserAccount({ ...baseInit, shell: '/usr/sbin/nologin' }).isLoginDisabledByShell()).toBe(true);
    expect(new LinuxUserAccount({ ...baseInit }).isLoginDisabledByShell()).toBe(false);
  });

  it('reports an account with no usable password', () => {
    expect(new LinuxUserAccount({ ...baseInit, password: '!' }).hasUsablePassword()).toBe(false);
    expect(new LinuxUserAccount({ ...baseInit, password: '$6$x' }).hasUsablePassword()).toBe(true);
  });

  it('computes password expiry against an age window', () => {
    const today = daysSinceEpoch();
    const fresh = new LinuxUserAccount({ ...baseInit, lastChange: today, maxDays: 30 });
    const stale = new LinuxUserAccount({ ...baseInit, lastChange: today - 90, maxDays: 30 });
    expect(fresh.isPasswordExpired(today)).toBe(false);
    expect(stale.isPasswordExpired(today)).toBe(true);
  });

  it('records logins and failed attempts', () => {
    const acc = new LinuxUserAccount({ ...baseInit });
    acc.recordFailedLogin();
    acc.recordFailedLogin();
    expect(acc.failedLoginCount).toBe(2);
    acc.recordLogin(123);
    expect(acc.lastLoginAt).toBe(123);
    expect(acc.failedLoginCount).toBe(0);
  });
});

describe('LinuxGroup', () => {
  it('manages membership idempotently', () => {
    const g = new LinuxGroup({ name: 'dev', gid: 1100 });
    expect(g.addMember('bob')).toBe(true);
    expect(g.addMember('bob')).toBe(false);
    expect(g.hasMember('bob')).toBe(true);
    expect(g.removeMember('bob')).toBe(true);
    expect(g.removeMember('bob')).toBe(false);
  });

  it('renders an /etc/group line', () => {
    const g = new LinuxGroup({ name: 'dev', gid: 1100, members: ['bob', 'amy'] });
    expect(g.toGroupLine()).toBe('dev:x:1100:bob,amy');
  });
});

// ═══════════════════════════════════════════════════════════════════
// LinuxFlowBuilder — useradd is silent, adduser is interactive
// ═══════════════════════════════════════════════════════════════════

function createMockDevice(overrides?: Record<string, unknown>) {
  return {
    canSudo: vi.fn().mockReturnValue(true),
    checkPassword: vi.fn().mockReturnValue(true),
    setUserPassword: vi.fn(),
    setUserGecos: vi.fn(),
    userExists: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

/** Count how many steps of a given type a flow contains. */
function countSteps(steps: InteractiveStep[], type: string): number {
  return steps.filter((s) => s.type === type).length;
}

/** Type-safe extraction of a domain-event payload by topic. */
function payloadOf<T extends DomainEvent['topic']>(
  events: DomainEvent[],
  topic: T,
): Extract<DomainEvent, { topic: T }>['payload'] | undefined {
  const event = events.find(
    (e): e is Extract<DomainEvent, { topic: T }> => e.topic === topic,
  );
  return event?.payload;
}

describe('LinuxFlowBuilder — useradd is non-interactive (faithful)', () => {
  it('never builds a flow for `useradd` as root', () => {
    const device = createMockDevice();
    expect(LinuxFlowBuilder.build('useradd bob', 'root', 0, device)).toBeNull();
    expect(LinuxFlowBuilder.build('useradd -m -s /bin/bash bob', 'root', 0, device)).toBeNull();
  });

  it('`sudo useradd` only authenticates sudo — no password/GECOS capture', () => {
    const device = createMockDevice();
    const steps = LinuxFlowBuilder.build('sudo useradd bob', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(countSteps(steps!, 'password')).toBe(1); // sudo password only
    expect(countSteps(steps!, 'text')).toBe(0);
    expect(countSteps(steps!, 'confirmation')).toBe(0);
  });
});

describe('LinuxFlowBuilder — adduser (root)', () => {
  it('builds an interactive flow for a plain user creation', () => {
    const device = createMockDevice();
    const steps = LinuxFlowBuilder.build('adduser bob', 'root', 0, device);
    expect(steps).not.toBeNull();
    expect(countSteps(steps!, 'password')).toBe(2);   // new + retype
    expect(countSteps(steps!, 'text')).toBe(5);       // 5 GECOS fields
    expect(countSteps(steps!, 'confirmation')).toBe(1);
  });

  it('skips the GECOS prompts when --gecos is supplied (quote-aware)', () => {
    const device = createMockDevice();
    const steps = LinuxFlowBuilder.build('adduser --gecos "Bob Martin" bob', 'root', 0, device);
    expect(steps).not.toBeNull();
    expect(countSteps(steps!, 'password')).toBe(2);
    expect(countSteps(steps!, 'text')).toBe(0);
  });

  it('skips the password prompts with --disabled-password', () => {
    const device = createMockDevice();
    const steps = LinuxFlowBuilder.build('adduser --disabled-password bob', 'root', 0, device);
    expect(steps).not.toBeNull();
    expect(countSteps(steps!, 'password')).toBe(0);
    expect(countSteps(steps!, 'text')).toBe(5);
  });

  it('returns null for the add-to-group overload', () => {
    const device = createMockDevice();
    expect(LinuxFlowBuilder.build('adduser bob sudo', 'root', 0, device)).toBeNull();
  });

  it('returns null for the create-group overload', () => {
    const device = createMockDevice();
    expect(LinuxFlowBuilder.build('adduser --group dev', 'root', 0, device)).toBeNull();
  });

  it('returns null for a --system account (non-interactive)', () => {
    const device = createMockDevice();
    expect(LinuxFlowBuilder.build('adduser --system svc', 'root', 0, device)).toBeNull();
  });

  it('returns null when the account already exists', () => {
    const device = createMockDevice({ userExists: vi.fn().mockReturnValue(true) });
    expect(LinuxFlowBuilder.build('adduser bob', 'root', 0, device)).toBeNull();
  });
});

describe('LinuxFlowBuilder — sudo adduser', () => {
  it('prepends a sudo password step to the creation flow', () => {
    const device = createMockDevice();
    const steps = LinuxFlowBuilder.build('sudo adduser bob', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(countSteps(steps!, 'password')).toBe(3); // sudo + new + retype
    expect(countSteps(steps!, 'text')).toBe(5);
  });

  it('only authenticates sudo for the add-to-group overload', () => {
    const device = createMockDevice();
    const steps = LinuxFlowBuilder.build('sudo adduser bob sudo', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(countSteps(steps!, 'password')).toBe(1);
    expect(countSteps(steps!, 'text')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// LinuxUserManager — behaviour + reactive events
// ═══════════════════════════════════════════════════════════════════

function makeManager(): { mgr: LinuxUserManager; events: DomainEvent[] } {
  const mgr = new LinuxUserManager(new VirtualFileSystem());
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribeAll((e) => events.push(e));
  mgr.attachBus(bus, 'dev-1');
  return { mgr, events };
}

describe('LinuxUserManager.useradd', () => {
  it('creates an account with a user-private group', () => {
    const { mgr } = makeManager();
    expect(mgr.useradd('bob', {})).toBe('');
    const bob = mgr.getAccount('bob');
    expect(bob).toBeDefined();
    expect(mgr.getGroup('bob')?.gid).toBe(bob!.gid);
  });

  it('rejects a duplicate username', () => {
    const { mgr } = makeManager();
    mgr.useradd('bob', {});
    expect(mgr.useradd('bob', {})).toContain('already exists');
  });

  it('honours an explicit UID and rejects a non-unique one without -o', () => {
    const { mgr } = makeManager();
    expect(mgr.useradd('a', { u: 1500 })).toBe('');
    expect(mgr.getAccount('a')!.uid).toBe(1500);
    expect(mgr.useradd('b', { u: 1500 })).toContain('not unique');
    expect(mgr.useradd('c', { u: 1500, o: true })).toBe('');
  });

  it('allocates a system account from the 100-999 UID range with -r', () => {
    const { mgr } = makeManager();
    mgr.useradd('svc', { r: true });
    const svc = mgr.getAccount('svc')!;
    expect(svc.kind).toBe('system');
    expect(svc.uid).toBeGreaterThanOrEqual(100);
    expect(svc.uid).toBeLessThan(1000);
  });

  it('stores the GECOS comment from -c and leaves it empty otherwise', () => {
    const { mgr } = makeManager();
    mgr.useradd('bob', { c: 'Bob Martin' });
    mgr.useradd('amy', {});
    expect(mgr.getUser('bob')!.gecos).toBe('Bob Martin');
    expect(mgr.getent('passwd', 'amy')).toMatch(/amy:x:\d+:\d+::/);
  });

  it('publishes a linux.iam.user.created event', () => {
    const { mgr, events } = makeManager();
    mgr.useradd('bob', {});
    const created = payloadOf(events, 'linux.iam.user.created');
    expect(created).toBeDefined();
    expect(created!.deviceId).toBe('dev-1');
    expect(created!.username).toBe('bob');
    expect(created!.userPrivateGroupCreated).toBe(true);
  });

  it('publishes password / deletion / gecos events', () => {
    const { mgr, events } = makeManager();
    mgr.useradd('bob', {});
    mgr.setPassword('bob', 'secret');
    mgr.setUserGecos('bob', 'Bob Martin', '101', '', '', '');
    mgr.userdel('bob', false);
    expect(events.some((e) => e.topic === 'linux.iam.user.password-changed')).toBe(true);
    expect(events.some((e) => e.topic === 'linux.iam.user.gecos-changed')).toBe(true);
    expect(events.some((e) => e.topic === 'linux.iam.user.deleted')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Executor — faithful `adduser` / `addgroup`
// ═══════════════════════════════════════════════════════════════════

describe('adduser — faithful Debian behaviour', () => {
  it('prints the realistic creation banner', async () => {
    // bob is auto-provisioned at boot; pick a fresh name to exercise
    // the first-creation banner.
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('adduser zoe');
    expect(out).toContain("Adding user `zoe' ...");
    expect(out).toContain("Adding new group `zoe'");
    expect(out).toContain("Adding new user `zoe' (");
    expect(out).toContain("with group `zoe'");
    expect(out).toContain("Creating home directory `/home/zoe' ...");
    expect(out).toContain("Copying files from `/etc/skel' ...");
  });

  it('rejects an already-existing user', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('adduser bob');
    const out = await srv.executeCommand('adduser bob');
    expect(out).toContain("The user `bob' already exists.");
  });

  it('adds an existing user to an existing group (add-to-group overload)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('adduser bob');
    const out = await srv.executeCommand('adduser bob sudo');
    expect(out).toContain("Adding user `bob' to group `sudo' ...");
    expect(out).toContain('Done.');
    const groups = await srv.executeCommand('groups bob');
    expect(groups).toContain('sudo');
  });

  it('reports a missing user for the add-to-group overload', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('adduser ghost sudo');
    expect(out).toContain("The user `ghost' does not exist.");
  });

  it('creates a group with --group', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('adduser --group developers');
    expect(out).toContain("Adding group `developers' (GID");
    expect(await srv.executeCommand('getent group developers')).toContain('developers');
  });

  it('creates a group via the addgroup alias', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('addgroup ops');
    expect(out).toContain("Adding group `ops' (GID");
  });

  it('creates a system account in the system UID range with --system', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('adduser --system mysvc');
    expect(out).toContain("Adding system user `mysvc'");
    const uid = parseInt((await srv.executeCommand('id -u mysvc')).trim(), 10);
    expect(uid).toBeGreaterThanOrEqual(100);
    expect(uid).toBeLessThan(1000);
  });

  it('honours --gecos by writing it straight into /etc/passwd', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('adduser --gecos "Auto User" autouser');
    expect(await srv.executeCommand('getent passwd autouser')).toContain('Auto User');
  });

  it('skips the home directory with --no-create-home', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('adduser --no-create-home --gecos "No Home" nohome');
    expect(out).toContain('Not creating home directory');
  });
});
