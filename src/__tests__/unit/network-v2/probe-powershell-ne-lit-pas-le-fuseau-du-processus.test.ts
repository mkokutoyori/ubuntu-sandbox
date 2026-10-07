/**
 * Une machine Windows simulee porte SON fuseau (`Set-TimeZone`, `tzutil`). Or cmd et PowerShell
 * lisaient les accesseurs locaux d'un `Date` JavaScript, c'est-a-dire le fuseau du PROCESSUS — en
 * production celui du NAVIGATEUR : `dir`, `systeminfo`, `net user`, `ipconfig /displaydns`,
 * `schtasks /query`, `Get-Date -Format`, `Get-Process` (StartTime), `Get-LocalUser`,
 * `Get-ScheduledTaskInfo`, `Get-CimInstance Win32_OperatingSystem` montraient l'heure de Paris ou
 * de New York selon qui regardait.
 *
 * MESURE : la meme suite de commandes cmd et PowerShell, une machine en UTC, jouee sous `TZ=UTC`
 * puis sous `TZ=Pacific/Auckland` pour le processus : 8 sorties sur 23 differaient (`net user`, `systeminfo`,
 * `dir /t:c`, `dir C:\\Windows`, `Get-Date`, `Get-Date -UFormat`, `(Get-Date).Hour`, `Get-ChildItem`). En dessous du
 * rendu, des fonctions manquaient ou rendaient vide : `Get-Date -UFormat`, `-AsUTC`, `[DateTime]::Now`
 * et ses membres (`.Year`, `.ToString("o")`), `[TimeZoneInfo]::Local`, `LastBootUpTime` de
 * `Win32_OperatingSystem`, `StartTime` des processus. Et le planificateur de taches Windows
 * n'etait JAMAIS arme a la construction de la machine : une tache `schtasks /create` ne se
 * declenchait que si quelqu'un appelait `powerOn()` — jamais dans l'application.
 *
 * Corrige en portant le fuseau de la MACHINE par la valeur elle-meme (`ZonedDate`, un `Date` dont
 * les accesseurs locaux lisent le fuseau de la machine), la seule ecriture de `.NET DateTime`
 * (`formatDotNetDate`) et le fuseau passe aux formateurs cmd.
 *
 * Discriminee contre l'etat d'avant (sources de `mandeng-fuseaux-et-dates`, meme sonde) : 4 des 6 cas
 * tombent. Les 2 qui passent des deux cotes sont NOMMES : le temoin (la suite d'une machine UTC est
 * stable sous un processus UTC, elle prouve que le laboratoire est sain) et `time /t` en Tokyo
 * (non-regression : cette commande lisait deja le fuseau de la machine).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const ORIGINAL_TZ = process.env.TZ;
const ORIGIN_MS = Date.UTC(2026, 9, 6, 18, 25, 0);

const CMD = [
  'date /t', 'time /t', 'schtasks /query /fo list | findstr /i "Next"',
  'net user Administrator | findstr /i "last"', 'systeminfo | findstr /i "Boot"',
  'dir C:\\ /t:c', 'dir C:\\Windows | findstr /i "System32"', 'wmic os get lastbootuptime',
  'net statistics workstation | findstr /i "since"', 'ipconfig /displaydns | findstr /i "Record"',
];
const PS = [
  'Get-Date', 'Get-Date -Format o', '(Get-Date).ToString("u")', 'Get-Date -UFormat "%H:%M"',
  'Get-Date -AsUTC -Format o', '[DateTime]::Now.ToString("o")', '[DateTime]::Now.Year', '(Get-Date).Hour',
  '[TimeZoneInfo]::Local.Id', '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime',
  'Get-Process | Select-Object -First 2 | Format-Table Name,StartTime',
  'Get-LocalUser Administrator | Format-List LastLogon,PasswordLastSet',
  'Get-ChildItem C:\\ | Select-Object -First 3 | Format-Table Name,LastWriteTime',
];

async function lab(processZone: string, machineZone?: string) {
  process.env.TZ = processZone;
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: ORIGIN_MS }));
  const pc = new WindowsPC('windows-pc', 'W1');
  pc.setCurrentUser('Administrator');
  const ps = PowerShellSubShell.create(pc).subShell;
  if (machineZone !== undefined) await ps.processLine(`Set-TimeZone -Id "${machineZone}"`);
  await clock.advance(3 * 3600_000 + 17 * 60_000);
  return { pc, ps, clock };
}

async function transcript(processZone: string): Promise<string[]> {
  const { pc, ps } = await lab(processZone);
  const out: string[] = [];
  for (const command of CMD) out.push(await pc.executeCommand(command));
  for (const command of PS) out.push((await ps.processLine(command)).output.join('\n'));
  return out;
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  __resetSimulationClock();
});

describe('a Windows machine prints its own time zone, not the one of the process', () => {
  it('witness: the transcript of a UTC machine is stable under a UTC process and carries the time', async () => {
    const first = await transcript('UTC');
    const second = await transcript('UTC');
    expect(second).toEqual(first);
    expect(first[1]).toContain('9:42 PM');
  });

  it('the transcript of a UTC machine does not depend on the zone of the process', async () => {
    const names = [...CMD, ...PS];
    const utc = await transcript('UTC');
    const auckland = await transcript('Pacific/Auckland');
    const leaking = names.filter((_, i) => utc[i] !== auckland[i]);
    expect(leaking).toEqual([]);
  });

  describe('a machine set to Tokyo', () => {
    it('Get-Date, [DateTime] and TimeZoneInfo answer in Tokyo time', async () => {
      const { ps } = await lab('UTC', 'Tokyo Standard Time');
      const run = async (c: string) => (await ps.processLine(c)).output.join('\n');
      expect(await run('Get-Date -Format "yyyy-MM-dd HH:mm"')).toBe('2026-10-07 06:42');
      expect(await run('Get-Date -Format o')).toMatch(/^2026-10-07T06:42:\d\d\.\d{7}\+09:00$/);
      expect(await run('(Get-Date).ToString("u")')).toMatch(/^2026-10-06 21:42:\d\dZ$/);
      expect(await run('Get-Date -AsUTC -Format "HH:mm"')).toBe('21:42');
      expect(await run('Get-Date -UFormat "%H:%M %Z"')).toBe('06:42 +09');
      expect(await run('[DateTime]::Now.Year')).toBe('2026');
      expect(await run('[DateTime]::UtcNow.Hour')).toBe('21');
      expect(await run('[DateTime]::Now.Hour')).toBe('6');
      expect(await run('[TimeZoneInfo]::Local.Id')).toBe('Tokyo Standard Time');
    });

    it('cmd and PowerShell agree on the boot time of the machine', async () => {
      const { pc, ps } = await lab('UTC', 'Tokyo Standard Time');
      const wmic = await pc.executeCommand('wmic os get lastbootuptime');
      const cim = (await ps.processLine('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime')).output.join('\n');
      expect(wmic).toMatch(/20261007032500\.\d{6}\+540/);
      expect(cim).toBe('Wednesday, October 7, 2026 3:25:00 AM');
    });

    it('date /t and time /t stay in Tokyo time', async () => {
      const { pc } = await lab('UTC', 'Tokyo Standard Time');
      expect(await pc.executeCommand('time /t')).toContain('6:42 AM');
      expect(await pc.executeCommand('date /t')).toContain('10/07/2026');
    });
  });

  describe('the task scheduler', () => {
    it('fires a task at its local time without anyone powering the machine on, and cmd and PowerShell agree', async () => {
      const { pc, ps, clock } = await lab('UTC', 'Tokyo Standard Time');
      await pc.executeCommand('schtasks /create /tn Daily3 /tr "cmd /c echo hi" /sc daily /st 03:00');
      const before = await pc.executeCommand('schtasks /query /tn Daily3 /v /fo list | findstr /i "Next Last"');
      expect(before).toContain('10/08/2026 03:00:00');
      await clock.advance(24 * 3600_000);
      const after = await pc.executeCommand('schtasks /query /tn Daily3 /v /fo list | findstr /i "Next Last"');
      expect(after).toMatch(/Next Run Time:\s+10\/09\/2026 03:00:00/);
      expect(after).toMatch(/Last Run Time:\s+10\/08\/2026 03:00:00/);
      const info = (await ps.processLine('Get-ScheduledTaskInfo -TaskName Daily3 | Format-List LastRunTime,NextRunTime')).output.join('\n');
      expect(info).toMatch(/LastRunTime : 10\/8\/2026 3:00 AM/);
      expect(info).toMatch(/NextRunTime : 10\/9\/2026 3:00 AM/);
    });
  });
});
