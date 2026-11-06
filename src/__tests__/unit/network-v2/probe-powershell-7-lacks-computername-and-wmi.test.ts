/*
 * Reference: the real PowerShell source (github.com/PowerShell/PowerShell, Process.cs and Service.cs, InitialSessionState.cs). PowerShell 7 is the only PowerShell of the
 * project: GetProcessCommand and the Service cmdlets declare NO -ComputerName (RemotingCapability.SupportedByCommand: remoting goes through Invoke-Command), and the WMI v1
 * cmdlets Get-WmiObject and its aliases gwmi, iwmi, rwmi sit under '#if !CORECLR'. `powershell` and `pwsh` open the same PowerShell 7.6, so neither accepts them.
 *
 * Measured against the commit before (worktree): the `powershell` launcher still opened Windows PowerShell 5.1 and accepted both; 4 of the 8 cases fall (the `powershell`
 * ones); the 4 `pwsh` ones pass either way and are the WITNESSES that the refusal was already there.
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

async function pc() {
  await buildDnsAgenceBancaire();
  return [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === 'PC-GUICHET1') as unknown as Shell;
}

const WINDOWS = (code: string) => `powershell -NoProfile -Command "${code}"`;
const CORE = (code: string) => `pwsh -NoProfile -Command "${code}"`;

describe('PowerShell 7 is the one PowerShell: no -ComputerName on Get-Process/Get-Service, no Get-WmiObject', () => {
  it.each([WINDOWS, CORE])('Get-Process -ComputerName, Get-Service -ComputerName and the shortened -Comp are refused', async (wrap) => {
    for (const line of ['Get-Process -ComputerName localhost', 'Get-Service -ComputerName localhost', 'Get-Service -Comp localhost']) {
      expect(await (await pc()).executeCommand(wrap(line))).toContain('A parameter cannot be found that matches parameter name');
    }
  });

  it.each([WINDOWS, CORE])('Get-WmiObject is not a command', async (wrap) => {
    expect(await (await pc()).executeCommand(wrap('Get-WmiObject Win32_OperatingSystem'))).toContain('not recognized');
  });

  it.each([WINDOWS, CORE])('Get-CimInstance answers the operating system name', async (wrap) => {
    expect(await (await pc()).executeCommand(wrap('(Get-CimInstance Win32_OperatingSystem).CSName'))).toContain('PC-GUICHET1');
  });
});
