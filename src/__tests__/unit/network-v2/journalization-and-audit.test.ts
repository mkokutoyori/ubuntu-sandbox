/**
 * Journalization & audit-trail enhancement — tests.
 *
 * Covers:
 *   - LinuxAuditLog / LinuxAuditRecord — the auditd record model, query and
 *     `/var/log/audit/audit.log` rendering
 *   - AuditTrailProjection — security events recorded reactively
 *   - ausearch / aureport / auditctl — the audit query commands
 *   - rsyslog coherence — stopping the syslog daemon freezes /var/log/*
 *     while journald (journalctl) keeps recording
 *   - Windows — the Service Control Manager journals 7036 events
 */

import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxAuditLog, LinuxAuditRecord } from '@/network/devices/linux/audit/LinuxAuditLog';
import { AuditTrailProjection } from '@/network/devices/linux/audit/AuditTrailProjection';
import { cmdAusearch, cmdAureport, cmdAuditctl } from '@/network/devices/linux/audit/AuditCommands';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { EventBus } from '@/events/EventBus';
import { WindowsServiceManager } from '@/network/devices/windows/WindowsServiceManager';
import { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';
import { WindowsProcessManager } from '@/network/devices/windows/WindowsProcessManager';
import { WindowsSecurityAudit } from '@/network/devices/windows/WindowsSecurityAudit';
import { WindowsSecurityAuditProjection } from '@/network/devices/windows/WindowsSecurityAuditProjection';
import { WindowsEventLogProjection } from '@/network/devices/windows/WindowsEventLogProjection';

// ═══════════════════════════════════════════════════════════════════
// LinuxAuditRecord / LinuxAuditLog
// ═══════════════════════════════════════════════════════════════════

describe('LinuxAuditRecord', () => {
  it('renders the canonical auditd line format', () => {
    const rec = new LinuxAuditRecord('ADD_USER', 42, { uid: 0, acct: 'bob', res: 'success' }, 1_600_000_000_000);
    const line = rec.render();
    expect(line).toMatch(/^type=ADD_USER msg=audit\(1600000000\.000:42\): /);
    expect(line).toContain('acct=bob');
    expect(line).toContain('res=success');
  });

  it('quotes values containing whitespace', () => {
    const rec = new LinuxAuditRecord('USER_CMD', 1, { cmd: 'rm -rf /tmp' });
    expect(rec.render()).toContain('cmd="rm -rf /tmp"');
  });

  it('reports success from the res field', () => {
    expect(new LinuxAuditRecord('X', 1, { res: 'success' }).succeeded).toBe(true);
    expect(new LinuxAuditRecord('X', 1, { res: 'failed' }).succeeded).toBe(false);
  });
});

describe('LinuxAuditLog', () => {
  it('appends records with monotonic serials and materialises audit.log', () => {
    const vfs = new VirtualFileSystem();
    const log = new LinuxAuditLog(vfs);
    log.record('ADD_USER', { acct: 'bob' });
    log.record('DEL_USER', { acct: 'bob' });

    expect(log.all()).toHaveLength(2);
    expect(log.all()[0].serial).toBe(1);
    expect(log.all()[1].serial).toBe(2);
    expect(vfs.readFile('/var/log/audit/audit.log')).toContain('type=ADD_USER');
  });

  it('queries by record type', () => {
    const log = new LinuxAuditLog(new VirtualFileSystem());
    log.record('ADD_USER', { acct: 'bob' });
    log.record('USER_CHAUTHTOK', { acct: 'bob' });
    expect(log.query({ type: 'ADD_USER' })).toHaveLength(1);
  });

  it('queries by field key/value and by success', () => {
    const log = new LinuxAuditLog(new VirtualFileSystem());
    log.record('USER_LOGIN', { acct: 'bob', res: 'success' });
    log.record('USER_LOGIN', { acct: 'eve', res: 'failed' });
    expect(log.query({ key: 'acct', value: 'bob' })).toHaveLength(1);
    expect(log.query({ success: false })).toHaveLength(1);
  });

  it('counts records by type for aureport', () => {
    const log = new LinuxAuditLog(new VirtualFileSystem());
    log.record('ADD_USER', {});
    log.record('ADD_USER', {});
    log.record('SERVICE_START', {});
    expect(log.countByType().get('ADD_USER')).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// AuditTrailProjection
// ═══════════════════════════════════════════════════════════════════

describe('AuditTrailProjection', () => {
  function wired() {
    const bus = new EventBus();
    const log = new LinuxAuditLog(new VirtualFileSystem());
    new AuditTrailProjection(bus, log, 'dev-1');
    return { bus, log };
  }

  it('records an ADD_USER event when an account is created', () => {
    const { bus, log } = wired();
    bus.publish({
      topic: 'linux.iam.user.created',
      payload: {
        deviceId: 'dev-1', username: 'bob', uid: 1001, gid: 1001,
        home: '/home/bob', shell: '/bin/bash', kind: 'regular',
        supplementaryGroups: [], userPrivateGroupCreated: true,
      },
    });
    expect(log.query({ type: 'ADD_USER' })).toHaveLength(1);
    expect(log.all()[0].get('acct')).toBe('bob');
  });

  it('records a USER_CHAUTHTOK event on a password change', () => {
    const { bus, log } = wired();
    bus.publish({
      topic: 'linux.iam.user.password-changed',
      payload: { deviceId: 'dev-1', username: 'bob', uid: 1001, disabled: false },
    });
    expect(log.query({ type: 'USER_CHAUTHTOK' })).toHaveLength(1);
  });

  it('records a SERVICE_START event on service activation', () => {
    const { bus, log } = wired();
    bus.publish({
      topic: 'linux.service.started',
      payload: { deviceId: 'dev-1', name: 'nginx', state: 'active', type: 'forking' },
    });
    expect(log.query({ type: 'SERVICE_START' })).toHaveLength(1);
  });

  it('ignores events from another device', () => {
    const { bus, log } = wired();
    bus.publish({
      topic: 'linux.iam.user.deleted',
      payload: { deviceId: 'other', username: 'bob', uid: 1001, homeRemoved: true },
    });
    expect(log.all()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Audit query commands
// ═══════════════════════════════════════════════════════════════════

describe('ausearch / aureport / auditctl', () => {
  function seeded(): LinuxAuditLog {
    const log = new LinuxAuditLog(new VirtualFileSystem());
    log.record('ADD_USER', { acct: 'bob', res: 'success' });
    log.record('USER_CHAUTHTOK', { acct: 'bob', res: 'success' });
    return log;
  }

  it('ausearch -m filters by record type', () => {
    const out = cmdAusearch(seeded(), ['-m', 'ADD_USER']);
    expect(out).toContain('type=ADD_USER');
    expect(out).not.toContain('USER_CHAUTHTOK');
  });

  it('ausearch reports no matches for an unknown type', () => {
    expect(cmdAusearch(seeded(), ['-m', 'NOPE'])).toBe('<no matches>');
  });

  it('aureport summarises the audit trail', () => {
    const out = cmdAureport(seeded(), []);
    expect(out).toContain('Summary Report');
    expect(out).toContain('Number of audit events: 2');
    expect(out).toContain('ADD_USER');
  });

  it('auditctl -s shows the subsystem status', () => {
    expect(cmdAuditctl(seeded(), ['-s'])).toContain('enabled 1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// End-to-end — Linux
// ═══════════════════════════════════════════════════════════════════

describe('Linux audit trail — end to end', () => {
  it('writes an ADD_USER record to /var/log/audit/audit.log on useradd', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    const auditLog = await srv.executeCommand('cat /var/log/audit/audit.log');
    expect(auditLog).toContain('type=ADD_USER');
    expect(auditLog).toContain('acct=bob');
  });

  it('answers ausearch queries over real account activity', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('useradd -m bob');
    const out = await srv.executeCommand('ausearch -m ADD_USER');
    expect(out).toContain('acct=bob');
  });
});

describe('rsyslog coherence', () => {
  it('freezes /var/log/syslog when rsyslog is stopped, journald keeps recording', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');

    await srv.executeCommand('logger -t test before-stop');
    expect(await srv.executeCommand('cat /var/log/syslog')).toContain('before-stop');

    await srv.executeCommand('systemctl stop rsyslog');
    await srv.executeCommand('logger -t test after-stop');

    // The on-disk file froze...
    expect(await srv.executeCommand('cat /var/log/syslog')).not.toContain('after-stop');
    // ...but journald (journalctl) kept the entry.
    expect(await srv.executeCommand('journalctl')).toContain('after-stop');
  });

  it('resumes file logging once rsyslog is started again', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('systemctl stop rsyslog');
    await srv.executeCommand('systemctl start rsyslog');
    await srv.executeCommand('logger -t test resumed-entry');
    expect(await srv.executeCommand('cat /var/log/syslog')).toContain('resumed-entry');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Windows — event-driven journalisation (pub/sub)
// ═══════════════════════════════════════════════════════════════════

/** A Windows device wired to a bus with both reactive log projections. */
function wiredWindows() {
  const bus = new EventBus();
  const events: Array<{ log: string; id: number; type: string; message: string }> = [];
  const sink = {
    writeEventLog: (log: string, _src: string, id: number, type: string, message: string) => {
      events.push({ log, id, type, message });
      return '';
    },
  };
  const userMgr = new WindowsUserManager();
  userMgr.currentUser = 'Administrator';
  userMgr.attachBus(bus, 'win-1');
  const svcMgr = new WindowsServiceManager();
  svcMgr.attachBus(bus, 'win-1');
  const procMgr = new WindowsProcessManager();
  procMgr.attachBus(bus, 'win-1');
  new WindowsSecurityAuditProjection(bus, new WindowsSecurityAudit(sink), 'win-1');
  new WindowsEventLogProjection(bus, sink, 'win-1');
  return { events, userMgr, svcMgr, procMgr };
}

describe('Windows service journalisation (reactive)', () => {
  it('journals a 7036 System-log event on service stop and start', () => {
    const { events, svcMgr } = wiredWindows();
    svcMgr.stopService('LanmanServer', true);
    svcMgr.startService('LanmanServer', true);

    const scm = events.filter((e) => e.id === 7036 && e.log === 'System');
    expect(scm.some((e) => e.message.includes('stopped'))).toBe(true);
    expect(scm.some((e) => e.message.includes('running'))).toBe(true);
  });
});

describe('Windows Security audit trail (reactive)', () => {
  it('journals event 4720 when a user account is created', () => {
    const { events, userMgr } = wiredWindows();
    userMgr.createUser('bob', 'P@ssw0rd!2024', {});
    expect(events.some((e) => e.id === 4720 && e.log === 'Security')).toBe(true);
  });

  it('journals event 4726 when a user account is deleted', () => {
    const { events, userMgr } = wiredWindows();
    userMgr.createUser('bob', 'P@ssw0rd!2024', {});
    userMgr.deleteUser('bob');
    expect(events.some((e) => e.id === 4726)).toBe(true);
  });

  it('journals event 4724 when a password is reset', () => {
    const { events, userMgr } = wiredWindows();
    userMgr.createUser('bob', 'P@ssw0rd!2024', {});
    userMgr.setUserProperty('bob', 'password', 'New@Pass!2024');
    expect(events.some((e) => e.id === 4724)).toBe(true);
  });

  it('journals 4722 / 4725 on account enable and disable', () => {
    const { events, userMgr } = wiredWindows();
    userMgr.createUser('bob', 'P@ssw0rd!2024', {});
    userMgr.disableUser('bob');
    userMgr.enableUser('bob');
    expect(events.some((e) => e.id === 4725)).toBe(true);
    expect(events.some((e) => e.id === 4722)).toBe(true);
  });

  it('journals 4731 / 4732 on group creation and membership', () => {
    const { events, userMgr } = wiredWindows();
    userMgr.createUser('bob', 'P@ssw0rd!2024', {});
    userMgr.createGroup('Engineers');
    userMgr.addGroupMember('Engineers', 'bob');
    expect(events.some((e) => e.id === 4731)).toBe(true);
    expect(events.some((e) => e.id === 4732)).toBe(true);
  });

  it('journals a 4624 success / 4625 failure logon audit', () => {
    const { events, userMgr } = wiredWindows();
    userMgr.createUser('bob', 'P@ssw0rd!2024', {});
    userMgr.checkPassword('bob', 'P@ssw0rd!2024');
    userMgr.checkPassword('bob', 'wrong');
    expect(events.some((e) => e.id === 4624 && e.type === 'SuccessAudit')).toBe(true);
    expect(events.some((e) => e.id === 4625 && e.type === 'FailureAudit')).toBe(true);
  });

  it('journals 4688 / 4689 on process creation and termination', () => {
    const { events, procMgr } = wiredWindows();
    const proc = procMgr.spawnProcess('notepad.exe', 100, 'User');
    procMgr.killProcess(proc.pid, true, true);
    expect(events.some((e) => e.id === 4688)).toBe(true);
    expect(events.some((e) => e.id === 4689)).toBe(true);
  });

  it('does not react to events from another device', () => {
    const bus = new EventBus();
    const events: number[] = [];
    new WindowsSecurityAuditProjection(
      bus,
      new WindowsSecurityAudit({ writeEventLog: (_l, _s, id) => { events.push(id); return ''; } }),
      'win-1',
    );
    bus.publish({
      topic: 'windows.account.changed',
      payload: { deviceId: 'other', account: 'bob', change: 'created' },
    });
    expect(events).toHaveLength(0);
  });
});
