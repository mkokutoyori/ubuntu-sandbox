/*
 * The project already owns the mechanism for '-ComputerName': powershell/cmdlets/remoteDispatch.ts 'remotable', which runs the cmdlet on the target over the WinRM channel (TCP 5985,
 * real frames, remote authentication) and tags the results with PSComputerName. It was applied to the DNS server cmdlets only. Get-Service and Get-Process each carried a PRIVATE refusal
 * ('There is no remote service control channel in this simulator', 'no remote process channel') and Get-CimInstance / Get-WmiObject did not declare -ComputerName at all, so they
 * answered with the LOCAL machine's data (CSName: PC-GUICHET1 for a query aimed at dc1). Now the three are wrapped with 'remotable', the two private refusals are deleted, and
 * 'remotable' passes -Credential to the channel the way Invoke-Command does.
 *
 * Measured against the commit before (worktree): 4 of the 5 cases fall; the 1 that passes either way is the WITNESS: a local name in -ComputerName runs locally.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

interface Shell { executeCommand(command: string): Promise<string> }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  await buildDnsAgenceBancaire();
  const find = (name: string) => [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === name) as unknown as Shell;
  const server = find('DC1');
  await server.executeCommand('powershell -Command "Enable-PSRemoting -Force"');
  await server.executeCommand('net user rmt P@ssw0rd1 /add');
  await server.executeCommand('net localgroup Administrators rmt /add');
  return find('PC-GUICHET1');
}

const ps = (code: string) => `powershell -NoProfile -Command "${code}"`;
const CREDENTIAL = "$c = New-Object System.Management.Automation.PSCredential('rmt', (ConvertTo-SecureString 'P@ssw0rd1' -AsPlainText -Force));";

describe('-ComputerName runs on the named machine', () => {
  it('WITNESS a local name in -ComputerName runs locally', async () => {
    const out = await (await lab()).executeCommand(ps('(Get-CimInstance -ComputerName localhost Win32_OperatingSystem).CSName'));
    expect(out).toContain('PC-GUICHET1');
  });

  it('Get-WmiObject -ComputerName answers with the remote machine', async () => {
    const out = await (await lab()).executeCommand(ps(`${CREDENTIAL} (Get-WmiObject -ComputerName dc1.horizon.local -Credential $c Win32_OperatingSystem).CSName`));
    expect(out).toContain('DC1');
    expect(out).not.toContain('PC-GUICHET1');
  });

  it('Get-CimInstance Win32_Service -ComputerName lists the remote services', async () => {
    const out = await (await lab()).executeCommand(ps(`${CREDENTIAL} $r = Get-CimInstance -ComputerName dc1.horizon.local -Credential $c Win32_Service; $r[0].PSComputerName`));
    expect(out).toContain('dc1.horizon.local');
  });

  it('Get-Service -ComputerName is no longer refused by a private channel message', async () => {
    const out = await (await lab()).executeCommand(ps('Get-Service -ComputerName dc1.horizon.local'));
    expect(out).not.toContain('no remote service control channel');
    expect(out).toContain('Cannot connect to dc1.horizon.local');
  });

  it('Get-Process -ComputerName goes through the same channel', async () => {
    const out = await (await lab()).executeCommand(ps('Get-Process -ComputerName nobody.horizon.local'));
    expect(out).not.toContain('no remote process channel');
    expect(out).toContain('Cannot connect to nobody.horizon.local');
  });
});
