/**
 * `chage`, `passwd` aging flags, `faillock` and the reactive password-policy
 * subsystem — integration tests.
 *
 * Covers:
 *   - the full `chage` option surface (-d -E -I -m -M -W -l), date parsing
 *     and the faithful `chage -l` aging report
 *   - the `passwd` maintenance overloads (-l -u -e -d -n -x -w -S)
 *   - the `faillock` tally command and the lockout threshold
 *   - filesystem coherence: pwquality.conf / faillock.conf / common-password
 *   - the reactive event stream: aging-changed, password.rejected,
 *     password-policy.changed, locked-out — published *and* consumed
 *     (IamPolicyFilesProjection rewrites config, IamAuthLogProjection logs).
 */

import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { EventBus } from '@/events/EventBus';
import { IamPolicyFilesProjection } from '@/network/devices/linux/iam/fs/IamPolicyFilesProjection';
import { IAM_PATHS } from '@/network/devices/linux/iam/fs/IamPaths';
import { cmdFaillock } from '@/network/devices/linux/LinuxUserCommands';
import type { ShellContext } from '@/network/devices/linux/LinuxFileCommands';
import type { DomainEvent } from '@/events/types';

// ─── Helpers ────────────────────────────────────────────────────────────

/** A manager wired to a fresh bus, with the reactive policy-files projection. */
function wiredManager(deviceId = 'dev-1') {
  const vfs = new VirtualFileSystem();
  const mgr = new LinuxUserManager(vfs);
  const bus = new EventBus();
  mgr.attachBus(bus, deviceId);
  const projection = new IamPolicyFilesProjection(bus, mgr, deviceId);
  return { vfs, mgr, bus, projection, deviceId };
}

/** Collect the payloads of every event published on a given topic. */
function capture<T extends DomainEvent['topic']>(bus: EventBus, topic: T) {
  const payloads: Array<Extract<DomainEvent, { topic: T }>['payload']> = [];
  bus.subscribe(topic, (e) => payloads.push(e.payload));
  return payloads;
}

// ═══════════════════════════════════════════════════════════════════
// chage — option surface
// ═══════════════════════════════════════════════════════════════════

describe('chage — aging modification', () => {
  it('sets the min/max/warn aging fields', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    await srv.executeCommand('chage -M 60 -m 5 -W 12 bob');

    const report = await srv.executeCommand('chage -l bob');
    expect(report).toContain('Maximum number of days between password change\t\t: 60');
    expect(report).toContain('Minimum number of days between password change\t\t: 5');
    expect(report).toContain('Number of days of warning before password expires\t: 12');
  });

  it('sets an absolute account expiry date from a calendar date', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    await srv.executeCommand('chage -E 2035-06-15 bob');

    expect(await srv.executeCommand('chage -l bob')).toContain('Account expires\t\t\t\t\t\t: Jun 15, 2035');
  });

  it('disables account expiry with -E -1', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    await srv.executeCommand('chage -E 2035-06-15 bob');
    await srv.executeCommand('chage -E -1 bob');

    expect(await srv.executeCommand('chage -l bob')).toContain('Account expires\t\t\t\t\t\t: never');
  });

  it('sets the password-inactivity grace with -I', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    await srv.executeCommand('chage -M 30 -I 9 bob');

    expect(await srv.executeCommand('chage -l bob')).not.toContain('Password inactive\t\t\t\t\t: never');
  });

  it('accepts long-form options', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    await srv.executeCommand('chage --maxdays 45 --warndays 3 bob');

    const report = await srv.executeCommand('chage -l bob');
    expect(report).toContain('Maximum number of days between password change\t\t: 45');
  });

  it('reports a faithful aging report for a fresh account', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');

    const report = await srv.executeCommand('chage -l bob');
    expect(report).toContain('Last password change');
    expect(report).toContain('Password expires\t\t\t\t\t: never');
    expect(report).toContain('Account expires\t\t\t\t\t\t: never');
  });

  it('rejects an unknown user', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    expect(await srv.executeCommand('chage -M 30 ghost')).toContain("user 'ghost' does not exist");
  });
});

// ═══════════════════════════════════════════════════════════════════
// passwd — maintenance overloads
// ═══════════════════════════════════════════════════════════════════

describe('passwd — account maintenance flags', () => {
  it('expires a password immediately with -e', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    srv.setUserPassword('bob', 'Str0ng!pwxy');

    expect(await srv.executeCommand('passwd -e bob')).toContain('expiry information changed');
    expect(await srv.executeCommand('chage -l bob')).toContain('password must be changed');
  });

  it('deletes a password with -d, leaving the account passwordless', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    srv.setUserPassword('bob', 'Str0ng!pwxy');

    await srv.executeCommand('passwd -d bob');
    expect(await srv.executeCommand('passwd -S bob')).toContain('NP');
  });

  it('applies aging fields through -n / -x / -w', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    await srv.executeCommand('passwd -n 3 -x 90 -w 10 bob');

    const report = await srv.executeCommand('chage -l bob');
    expect(report).toContain('Maximum number of days between password change\t\t: 90');
    expect(report).toContain('Minimum number of days between password change\t\t: 3');
  });

  it('locks and unlocks an account with -l / -u', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    srv.setUserPassword('bob', 'Str0ng!pwxy');

    await srv.executeCommand('passwd -l bob');
    expect(await srv.executeCommand('passwd -S bob')).toContain('L');
    await srv.executeCommand('passwd -u bob');
    expect(await srv.executeCommand('passwd -S bob')).toContain('P');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Filesystem coherence — PAM password-policy stack
// ═══════════════════════════════════════════════════════════════════

describe('password-policy filesystem coherence', () => {
  it('seeds /etc/security/pwquality.conf at boot', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const content = await srv.executeCommand(`cat ${IAM_PATHS.pwqualityConf}`);
    expect(content).toContain('minlen = 8');
    expect(content).toContain('enforcing = 1');
  });

  it('seeds /etc/security/faillock.conf at boot', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    expect(await srv.executeCommand(`cat ${IAM_PATHS.faillockConf}`)).toContain('deny = 3');
  });

  it('seeds /etc/pam.d/common-password referencing pam_pwquality', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    expect(await srv.executeCommand(`cat ${IAM_PATHS.pamCommonPassword}`)).toContain('pam_pwquality.so');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Reactive policy reconfiguration (manager ⇄ projection ⇄ filesystem)
// ═══════════════════════════════════════════════════════════════════

describe('reactive password-policy reconfiguration', () => {
  it('rewrites pwquality.conf when the quality policy changes', () => {
    const { vfs, mgr } = wiredManager();
    mgr.configurePasswordQuality({ minLength: 16, minClasses: 4 });

    const content = vfs.readFile(IAM_PATHS.pwqualityConf);
    expect(content).toContain('minlen = 16');
    expect(content).toContain('minclass = 4');
  });

  it('rewrites login.defs when the aging policy changes', () => {
    const { vfs, mgr } = wiredManager();
    mgr.configurePasswordAging({ maxDays: 45 });

    expect(vfs.readFile(IAM_PATHS.loginDefs)).toContain('PASS_MAX_DAYS   45');
  });

  it('rewrites faillock.conf when the lockout policy changes', () => {
    const { vfs, mgr } = wiredManager();
    mgr.configureAccountLockout({ deny: 5 });

    expect(vfs.readFile(IAM_PATHS.faillockConf)).toContain('deny = 5');
  });

  it('publishes a password-policy.changed event carrying the section', () => {
    const { mgr, bus } = wiredManager();
    const changes = capture(bus, 'linux.iam.password-policy.changed');

    mgr.configurePasswordQuality({ minLength: 12 });
    expect(changes).toHaveLength(1);
    expect(changes[0].section).toBe('quality');
    expect(changes[0].changedFields).toContain('minLength');
  });

  it('does not publish for a no-op reconfiguration', () => {
    const { mgr, bus } = wiredManager();
    const changes = capture(bus, 'linux.iam.password-policy.changed');
    mgr.configurePasswordQuality({ minLength: 8 });
    expect(changes).toHaveLength(0);
  });

  it('stamps freshly created accounts with the current aging policy', () => {
    const { mgr } = wiredManager();
    mgr.configurePasswordAging({ maxDays: 75, warnDays: 21 });
    mgr.useradd('bob');

    const bob = mgr.getAccount('bob')!;
    expect(bob.maxDays).toBe(75);
    expect(bob.warnDays).toBe(21);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Reactive event stream — aging, rejection, lockout
// ═══════════════════════════════════════════════════════════════════

describe('IAM aging & rejection events', () => {
  it('publishes user.aging-changed with the post-change shadow fields', () => {
    const { mgr, bus } = wiredManager();
    const events = capture(bus, 'linux.iam.user.aging-changed');

    mgr.useradd('bob');
    mgr.chage('bob', { M: 30, W: 14 });

    expect(events).toHaveLength(1);
    expect(events[0].changedFields.sort()).toEqual(['maxDays', 'warnDays']);
    expect(events[0].maxDays).toBe(30);
  });

  it('publishes password.rejected for a weak password (warn-only)', () => {
    const { mgr, bus } = wiredManager();
    const rejected = capture(bus, 'linux.iam.password.rejected');

    mgr.useradd('bob');
    mgr.setPassword('bob', 'admin');

    expect(rejected).toHaveLength(1);
    expect(rejected[0].blocked).toBe(false);
    expect(rejected[0].reasons.length).toBeGreaterThan(0);
  });

  it('does not publish password.rejected for a strong password', () => {
    const { mgr, bus } = wiredManager();
    const rejected = capture(bus, 'linux.iam.password.rejected');

    mgr.useradd('bob');
    mgr.setPassword('bob', 'Str0ng!pwxy');
    expect(rejected).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// faillock — lockout tally
// ═══════════════════════════════════════════════════════════════════

describe('faillock — lockout tally', () => {
  it('publishes user.locked-out once the deny threshold is reached', () => {
    const { mgr, bus } = wiredManager();
    const lockouts = capture(bus, 'linux.iam.user.locked-out');

    mgr.useradd('bob');
    mgr.setPassword('bob', 'Str0ng!pwxy');
    mgr.checkPassword('bob', 'wrong');
    mgr.checkPassword('bob', 'wrong');
    mgr.checkPassword('bob', 'wrong');

    expect(lockouts).toHaveLength(1);
    expect(lockouts[0].failedAttempts).toBe(3);
    expect(mgr.isAccountLockedOut('bob')).toBe(true);
  });

  it('clears the tally on a successful authentication', () => {
    const { mgr } = wiredManager();
    mgr.useradd('bob');
    mgr.setPassword('bob', 'Str0ng!pwxy');
    mgr.checkPassword('bob', 'wrong');
    mgr.checkPassword('bob', 'wrong');
    expect(mgr.checkPassword('bob', 'Str0ng!pwxy')).toBe(true);
    expect(mgr.isAccountLockedOut('bob')).toBe(false);
  });

  it('reports the tally through the faillock command', () => {
    const { mgr } = wiredManager();
    mgr.useradd('bob');
    mgr.setPassword('bob', 'Str0ng!pwxy');
    mgr.checkPassword('bob', 'wrong');
    mgr.checkPassword('bob', 'wrong');

    const ctx = { userMgr: mgr } as unknown as ShellContext;
    const report = cmdFaillock(ctx, ['--user', 'bob']);
    expect(report).toContain('bob:');
    expect(report).toContain('Valid');
  });

  it('resets the tally through faillock --reset', () => {
    const { mgr } = wiredManager();
    mgr.useradd('bob');
    mgr.setPassword('bob', 'Str0ng!pwxy');
    mgr.checkPassword('bob', 'wrong');
    mgr.checkPassword('bob', 'wrong');
    mgr.checkPassword('bob', 'wrong');

    const ctx = { userMgr: mgr } as unknown as ShellContext;
    cmdFaillock(ctx, ['--user', 'bob', '--reset']);
    expect(mgr.isAccountLockedOut('bob')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Reactive auth.log consumer
// ═══════════════════════════════════════════════════════════════════

describe('auth.log coherence — aging events', () => {
  it('records a chage aging change in /var/log/auth.log', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    await srv.executeCommand('chage -M 30 bob');

    const authLog = await srv.executeCommand('cat /var/log/auth.log');
    expect(authLog).toContain("changed password aging for 'bob'");
  });
});
