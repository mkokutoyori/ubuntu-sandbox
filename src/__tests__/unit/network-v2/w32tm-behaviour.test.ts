/**
 * W32Time behaviours that the one-shot command tests cannot see: the
 * registry is the single store (reg.exe, PowerShell and w32tm read and write
 * the same values), policy values win and are labelled, `/config` without
 * `/update` does not apply, the 0x1 flag really fixes the poll interval, a
 * stopped service refuses `/query`, a non-elevated session is refused, a
 * transfer too big for MaxPosPhaseCorrection is not resynced, and the System
 * log receives the Time-Service events.
 *
 * Reference: the Microsoft documentation of w32tm and of the W32Time registry
 * entries (Parameters, Config, TimeProviders); no Windows binary was
 * available to record. The tests therefore pin the documented contract, not
 * invented output.
 *
 * Measured against the previous implementation (private fields, no registry,
 * 0x1 read as symmetric, no policy, no event): 8 of the 11 cases fail and 3
 * pass. The passes are the witness (the lab synchronises), the SpecialPollInterval
 * case (the old poll cadence already exceeded 8 sends in 3000 s, so it cannot
 * discriminate) and the 0x2 case (the old code rejected only a different flag).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;
let serie = 0;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(admin = true) {
  const router = new CiscoRouter(`R${++serie}`);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'ntp master 2', 'end']) await router.executeCommand(c);
  const pc = new WindowsPC('windows-pc', `W${serie}`);
  if (admin) pc.setCurrentUser('Administrator');
  new Cable(`c${serie}`).connect(router.getPort('GigabitEthernet0/0')!, pc.getPorts()[0]);
  await pc.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.2 255.255.255.0');
  return { router, pc };
}

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters';
const line = (text: string, prefix: string): string => text.split('\n').find((l) => l.trim().startsWith(prefix))?.trim() ?? '';

describe('the registry is the single store', () => {
  it('the lab synchronises (witness)', async () => {
    const { pc } = await lab();
    await pc.executeCommand('w32tm /config /manualpeerlist:"10.0.0.1,0x8" /syncfromflags:manual /update');
    converge(clock, 300_000);
    expect(line(await pc.executeCommand('w32tm /query /status'), 'Stratum')).toContain('Stratum: 3');
  });

  it('w32tm /config is visible to reg query and to Get-ItemProperty', async () => {
    const { pc } = await lab();
    await pc.executeCommand('w32tm /config /manualpeerlist:"10.0.0.1,0x8" /syncfromflags:manual');
    expect(await pc.executeCommand(`reg query ${PARAMETERS} /v NtpServer`)).toContain('REG_SZ    10.0.0.1,0x8');
    expect(await pc.executeCommand(`reg query ${PARAMETERS} /v Type`)).toContain('REG_SZ    NTP');
    const shell = PowerShellSubShell.create(pc).subShell;
    const out = (await shell.processLine("(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters').NtpServer")).output.join('\n');
    expect(out.trim()).toBe('10.0.0.1,0x8');
  });

  it('reg add is read back by w32tm only after /config /update', async () => {
    const { pc } = await lab();
    await pc.executeCommand(`reg add ${PARAMETERS} /v NtpServer /t REG_SZ /d "10.0.0.1,0x8" /f`);
    converge(clock, 300_000);
    expect(line(await pc.executeCommand('w32tm /query /status'), 'Stratum')).toContain('Stratum: 0');
    await pc.executeCommand('w32tm /config /update');
    converge(clock, 300_000);
    expect(line(await pc.executeCommand('w32tm /query /status'), 'Stratum')).toContain('Stratum: 3');
  });

  it('a policy value wins and is labelled (Policy)', async () => {
    const { pc } = await lab();
    await pc.executeCommand('reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\W32time\\Parameters /v NtpServer /t REG_SZ /d "10.0.0.1,0x8" /f');
    const configuration = await pc.executeCommand('w32tm /query /configuration');
    expect(line(configuration, 'NtpServer:')).toBe('NtpServer: 10.0.0.1,0x8 (Policy)');
    expect(line(configuration, 'Type:')).toBe('Type: NTP (Local)');
  });
});

describe('flags and intervals are evaluated', () => {
  async function sentAfter(flags: string, seconds: number): Promise<number> {
    const { pc } = await lab();
    await pc.executeCommand(`w32tm /config /manualpeerlist:"10.0.0.1,${flags}" /syncfromflags:manual /update`);
    converge(clock, seconds * 1000, 10_000);
    const agent = (pc as unknown as { getNtpAgent(): import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent();
    return agent.getAssociation('10.0.0.1')!.sent;
  }

  it('0x1 (SpecialInterval) polls at SpecialPollInterval, not at MinPollInterval', async () => {
    const special = await sentAfter('0x9', 3600);
    const ordinary = await sentAfter('0x8', 3600);
    expect(special).toBeLessThan(ordinary);
    expect(special).toBeLessThanOrEqual(3);
  });

  it('SpecialPollInterval in the registry is honoured', async () => {
    const { pc } = await lab();
    await pc.executeCommand('reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\TimeProviders\\NtpClient /v SpecialPollInterval /t REG_DWORD /d 300 /f');
    await pc.executeCommand('w32tm /config /manualpeerlist:"10.0.0.1,0x9" /syncfromflags:manual /update');
    converge(clock, 3000_000, 10_000);
    const agent = (pc as unknown as { getNtpAgent(): import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent();
    expect(agent.getAssociation('10.0.0.1')!.sent).toBeGreaterThan(8);
  });

  it('0x2 alone is accepted (UseAsFallbackOnly) and the source is still used when it is the only one', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('w32tm /config /manualpeerlist:"10.0.0.1,0xA" /syncfromflags:manual /update');
    expect(out).toContain('The command completed successfully');
    converge(clock, 300_000);
    expect(line(await pc.executeCommand('w32tm /query /status'), 'Stratum')).toContain('Stratum: 3');
  });
});

describe('service and privilege', () => {
  it('refuses /config to a non-elevated session but answers /query', async () => {
    const { pc } = await lab(false);
    expect(await pc.executeCommand('w32tm /config /update')).toContain('Access is denied. (0x80070005)');
    expect(await pc.executeCommand('w32tm /query /source')).toBe('Local CMOS Clock');
  });

  it('a stopped service refuses /query', async () => {
    const { pc } = await lab();
    await pc.executeCommand('net stop w32time');
    expect(await pc.executeCommand('w32tm /query /status'))
      .toBe('The following error occurred: The service has not been started. (0x80070426)');
    await pc.executeCommand('net start w32time');
    expect(await pc.executeCommand('w32tm /query /status')).toContain('Leap Indicator');
  });

  it('does not resync across a transfer larger than MaxPosPhaseCorrection', async () => {
    const { pc, router } = await lab();
    await pc.executeCommand('w32tm /config /manualpeerlist:"10.0.0.1,0x8" /syncfromflags:manual /update');
    converge(clock, 300_000);
    (router.getNtpAgent().getConfig() as { offsetMs: number }).offsetMs = 2 * 86_400_000;
    converge(clock, 300_000);
    expect(await pc.executeCommand('w32tm /resync'))
      .toBe('Sending resync command to local computer\nThe computer did not resync because the required time change was too big.');
  });
});

describe('the System log receives the Time-Service events', () => {
  it('writes event 35 when the clock starts following a source', async () => {
    const { pc } = await lab();
    await pc.executeCommand('w32tm /config /manualpeerlist:"10.0.0.1,0x8" /syncfromflags:manual /update');
    converge(clock, 300_000);
    const out = await pc.executeCommand(
      'powershell -c "Get-WinEvent -FilterHashtable @{LogName=\'System\';ProviderName=\'Microsoft-Windows-Time-Service\';Id=35} | Select-Object -ExpandProperty Message"');
    expect(out).toContain('The time service is now synchronizing the system time with the time source 10.0.0.1 (ntp.m|0x8|0.0.0.0:123->10.0.0.1:123).');
  });
});
