/**
 * Unit tests — systemctl show / get-default / set-property / mask.
 *
 * The debug transcript returned "Unknown command verb show." and
 * "...get-default.", so the service config display side of the
 * set/show pattern was dead. These verbs must now work and reflect
 * writes (set-property → show).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('systemctl get-default / --version', () => {
  it('get-default differs between server and PC', () => {
    expect(new LinuxCommandExecutor(true).execute('systemctl get-default').trim())
      .toBe('multi-user.target');
    expect(new LinuxCommandExecutor(false).execute('systemctl get-default').trim())
      .toBe('graphical.target');
  });

  it('--version prints the systemd banner', () => {
    expect(new LinuxCommandExecutor(true).execute('systemctl --version'))
      .toContain('systemd 249');
  });
});

describe('systemctl show', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('show -p selects specific properties', () => {
    const out = exec.execute('systemctl show -p MainPID,ActiveState,SubState ssh');
    expect(out).toContain('ActiveState=active');
    expect(out).toContain('SubState=running');
    expect(out).toMatch(/MainPID=\d+/);
  });

  it('show with no property prints the default key set', () => {
    const out = exec.execute('systemctl show ssh');
    expect(out).toContain('Id=ssh.service');
    expect(out).toContain('FragmentPath=');
  });

  it('show on an unknown unit prints empty values, exit 0', () => {
    const out = exec.execute('systemctl show -p MainPID nope');
    expect(out.trim()).toBe('MainPID=');
  });

  it('a bare option invocation lists units instead of erroring', () => {
    const out = exec.execute('systemctl --type=service');
    expect(out).toContain('UNIT');
    expect(out).not.toContain('Unknown command verb');
  });
});

describe('systemctl set-property → show (set/show)', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('a set property is reflected by show', () => {
    exec.execute('systemctl set-property cron CPUQuota=50%');
    expect(exec.execute('systemctl show -p CPUQuota cron').trim())
      .toBe('CPUQuota=50%');
  });

  it('rejects an unknown property', () => {
    expect(exec.execute('systemctl set-property cron CleInconnue=1'))
      .toContain('unknown property');
  });

  it('rejects a malformed value', () => {
    expect(exec.execute('systemctl set-property cron CPUQuota=abc'))
      .toContain('Failed to parse');
  });
});

describe('systemctl mask / unmask (set/show)', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('mask makes is-enabled report masked, unmask restores it', () => {
    exec.execute('systemctl mask cron');
    expect(exec.execute('systemctl is-enabled cron').trim()).toBe('masked');
    exec.execute('systemctl unmask cron');
    expect(exec.execute('systemctl is-enabled cron').trim()).toBe('enabled');
  });
});
