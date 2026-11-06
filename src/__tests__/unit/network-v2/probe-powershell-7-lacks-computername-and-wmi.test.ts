/*
 * Reference: the real PowerShell source (github.com/PowerShell/PowerShell, src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs and Service.cs, and
 * src/System.Management.Automation/engine/InitialSessionState.cs). In PowerShell 7 (CoreCLR): GetProcessCommand and the Service cmdlets declare NO -ComputerName (they carry
 * RemotingCapability.SupportedByCommand: remoting goes through Invoke-Command), and the aliases 'gwmi', 'iwmi', 'rwmi' (Get-WmiObject and the other WMI v1 cmdlets) sit under '#if !CORECLR':
 * they exist in Windows PowerShell 5.1 only. The simulator models both editions (PSRuntime 'desktop' | 'core', the core-only mechanism) but only in one direction (coreOnly,
 * coreOnlyParameters); a 'pwsh' session accepted -ComputerName on Get-Process/Get-Service and ran Get-WmiObject. The mirror mechanism (desktopOnlyParameters, desktopOnlyAliases) now
 * refuses them in a core session, while powershell.exe (Windows PowerShell 5.1) keeps both.
 *
 * Measured against the commit before (worktree): 4 of the 6 cases fall; the 2 that pass either way are the WITNESSES (the 5.1 session still accepts -ComputerName and Get-WmiObject).
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

describe('PowerShell 7 against Windows PowerShell 5.1 (real PowerShell source)', () => {
  it('WITNESS 5.1: Get-Process -ComputerName is accepted', async () => {
    expect(await (await pc()).executeCommand(WINDOWS('Get-Process -ComputerName localhost | Select-Object -First 1 | Out-String'))).not.toContain('parameter cannot be found');
  });

  it('WITNESS 5.1: Get-WmiObject exists', async () => {
    expect(await (await pc()).executeCommand(WINDOWS('(Get-WmiObject Win32_OperatingSystem).CSName'))).toContain('PC-GUICHET1');
  });

  it.each(['Get-Process -ComputerName localhost', 'Get-Service -ComputerName localhost', 'Get-Service -Comp localhost'])('7: %s is refused', async (line) => {
    expect(await (await pc()).executeCommand(CORE(line))).toContain('A parameter cannot be found that matches parameter name');
  });

  it('7: Get-WmiObject is not a command', async () => {
    expect(await (await pc()).executeCommand(CORE('Get-WmiObject Win32_OperatingSystem'))).toContain('not recognized');
  });
});
