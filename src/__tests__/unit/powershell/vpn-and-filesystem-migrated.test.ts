/**
 * Phase 3 batches 3-4 — VPN cmdlets + Get-Item / Set-Item / Get-Acl /
 * Set-Acl. End-to-end through PowerShellSubShell so the executor + interp
 * state-sharing is exercised.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createShell() {
  const pc = new WindowsPC('windows-pc', 'WIN-VPN-FS');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('VPN cmdlets migrated', () => {
  it('Add-VpnConnection then Get-VpnConnection lists the new conn', async () => {
    const sh = createShell();
    await run(sh, 'Add-VpnConnection -Name CorpVpn -ServerAddress vpn.example.com');
    const out = await run(sh, 'Get-VpnConnection');
    expect(out).toContain('CorpVpn');
    expect(out).toContain('vpn.example.com');
  });

  it('Set-VpnConnection updates the server address', async () => {
    const sh = createShell();
    // Quoted addresses: bare `1.example.com` is lexed as number `1.0`.
    await run(sh, 'Add-VpnConnection -Name BackupVpn -ServerAddress "old.example.com"');
    await run(sh, 'Set-VpnConnection -Name BackupVpn -ServerAddress "new.example.com"');
    const out = await run(sh, 'Get-VpnConnection -Name BackupVpn');
    expect(out).toContain('new.example.com');
  });

  it('Remove-VpnConnection removes it', async () => {
    const sh = createShell();
    await run(sh, 'Add-VpnConnection -Name OneShot -ServerAddress x.example.com');
    await run(sh, 'Remove-VpnConnection -Name OneShot');
    const out = await run(sh, 'Get-VpnConnection');
    expect(out).not.toContain('OneShot');
  });
});

describe('Get-Item / Set-Item migrated', () => {
  it('Set-Item writes content; Get-Item returns the entry shape', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\probe -ItemType Directory -Force');
    await run(sh, 'Set-Item -Path C:\\probe\\hello.txt -Value "via cmdlet"');
    const out = await run(sh, 'Get-Item C:\\probe\\hello.txt');
    expect(out).toContain('hello.txt');
  });
});

describe('Get-Acl migrated', () => {
  it('Get-Acl on a known path returns Owner + Access info', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Acl C:\\Windows');
    expect(out.toLowerCase()).toContain('owner');
  });
});
