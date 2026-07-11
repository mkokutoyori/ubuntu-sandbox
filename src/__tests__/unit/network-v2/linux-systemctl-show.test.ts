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
  it('get-default differs between server and PC', async () => {
    expect((await new LinuxCommandExecutor(true).execute('systemctl get-default')).trim())
      .toBe('multi-user.target');
    expect((await new LinuxCommandExecutor(false).execute('systemctl get-default')).trim())
      .toBe('graphical.target');
  });

  it('--version prints the systemd banner', async () => {
    expect(await new LinuxCommandExecutor(true).execute('systemctl --version'))
      .toContain('systemd 249');
  });
});

describe('systemctl show', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('show -p selects specific properties', async () => {
    const out = await exec.execute('systemctl show -p MainPID,ActiveState,SubState ssh');
    expect(out).toContain('ActiveState=active');
    expect(out).toContain('SubState=running');
    expect(out).toMatch(/MainPID=\d+/);
  });

  it('show with no property prints the default key set', async () => {
    const out = await exec.execute('systemctl show ssh');
    expect(out).toContain('Id=ssh.service');
    expect(out).toContain('FragmentPath=');
  });

  it('show on an unknown unit prints empty values, exit 0', async () => {
    const out = await exec.execute('systemctl show -p MainPID nope');
    expect(out.trim()).toBe('MainPID=');
  });

  it('a bare option invocation lists units instead of erroring', async () => {
    const out = await exec.execute('systemctl --type=service');
    expect(out).toContain('UNIT');
    expect(out).not.toContain('Unknown command verb');
  });
});

describe('systemctl set-property → show (set/show)', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('a set property is reflected by show', async () => {
    await exec.execute('systemctl set-property cron CPUQuota=50%');
    expect((await exec.execute('systemctl show -p CPUQuota cron')).trim())
      .toBe('CPUQuota=50%');
  });

  it('rejects an unknown property', async () => {
    expect(await exec.execute('systemctl set-property cron CleInconnue=1'))
      .toContain('unknown property');
  });

  it('rejects a malformed value', async () => {
    expect(await exec.execute('systemctl set-property cron CPUQuota=abc'))
      .toContain('Failed to parse');
  });
});

describe('systemctl mask / unmask (set/show)', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('mask makes is-enabled report masked, unmask restores it', async () => {
    await exec.execute('systemctl mask cron');
    expect((await exec.execute('systemctl is-enabled cron')).trim()).toBe('masked');
    await exec.execute('systemctl unmask cron');
    expect((await exec.execute('systemctl is-enabled cron')).trim()).toBe('enabled');
  });
});
