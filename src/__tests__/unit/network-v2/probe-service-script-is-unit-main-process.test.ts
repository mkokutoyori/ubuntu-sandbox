/**
 * Mesure : le script d'un ExecStart tourne sous l'identite du processus
 * principal de l'unite (MainPID) pendant TOUTE son execution, pas seulement
 * jusqu'a son premier await.
 *
 * Avant le correctif, withProcessIdentity depilait l'identite des que la
 * promesse etait rendue : `$$` valait le pid du shell (39) au lieu de MainPID
 * (40) et un `ps` lance par le script avait le shell pour parent.
 * 2 cas sur 3 tombent avant le correctif ; le temoin (script lance a la main,
 * son pid differe de celui du shell) passe dans les deux etats.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function vfsOf(pc: LinuxPC): VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startUnit(pc: LinuxPC, lines: string[]): Promise<void> {
  vfsOf(pc).writeFile('/usr/local/bin/unit.sh', ['#!/bin/bash', ...lines, ''].join('\n'), 0, 0, 0o022);
  await pc.executeCommand('sudo chmod +x /usr/local/bin/unit.sh');
  vfsOf(pc).writeFile('/etc/systemd/system/probe.service',
    ['[Unit]', 'Description=Probe', '[Service]', 'ExecStart=/usr/local/bin/unit.sh', ''].join('\n'), 0, 0, 0o644);
  await pc.executeCommand('systemctl daemon-reload');
  await pc.executeCommand('systemctl start probe');
  await settle(50);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

describe('le script ExecStart est le processus principal de l unite', () => {
  it('$$ vaut MainPID', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await startUnit(pc, ['echo $$ > /tmp/unit.pid']);

    const mainPid = (await pc.executeCommand('systemctl show -p MainPID probe')).trim();
    expect(mainPid).toBe(`MainPID=${vfsOf(pc).readFile('/tmp/unit.pid')?.trim()}`);
  });

  it('un processus lance par le script a MainPID pour parent', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await startUnit(pc, ['ps -eo pid,ppid,cmd > /tmp/unit.ps']);

    const mainPid = (await pc.executeCommand('systemctl show -p MainPID probe')).trim().split('=')[1];
    const psLine = (vfsOf(pc).readFile('/tmp/unit.ps') ?? '').split('\n').find((l) => /\sps$/.test(l.trim()));
    expect(psLine?.trim().split(/\s+/)[1]).toBe(mainPid);
  });

  it('temoin : un script lance a la main n a pas le pid du shell', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const shellPid = (await pc.executeCommand('echo $$')).trim();
    vfsOf(pc).writeFile('/usr/local/bin/hand.sh', '#!/bin/bash\necho $$ > /tmp/hand.pid\n', 0, 0, 0o022);
    await pc.executeCommand('sudo chmod +x /usr/local/bin/hand.sh');
    await pc.executeCommand('/usr/local/bin/hand.sh');

    const seen = vfsOf(pc).readFile('/tmp/hand.pid')?.trim();
    expect(seen).toMatch(/^\d+$/);
    expect(seen).not.toBe(shellPid);
  });
});
