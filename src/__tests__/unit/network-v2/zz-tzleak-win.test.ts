import { it } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const CMD = ['date /t', 'time /t', 'echo %date% %time%', 'tzutil /g', 'schtasks /query /fo list | findstr /i "Next"', 'net user Administrator | findstr /i "last"', 'systeminfo | findstr /i "Boot"', 'dir C:\\ /t:c', 'dir C:\\Windows | findstr /i "System32"', 'w32tm /query /status | findstr /i "Last"', 'net statistics workstation | findstr /i "since"', 'wmic os get lastbootuptime', 'quser', 'net accounts | findstr /i "age"', 'eventcreate /t information /id 100 /l application /d "x"', 'wevtutil qe Application /c:1 /f:text /rd:true | findstr /i "Date"', 'netsh advfirewall firewall show rule name=all | findstr /i "Rule" | more', 'ver', 'hostname'];
const PS = ['Get-Date', 'Get-Date -Format o', '(Get-Date).ToString("u")', 'Get-TimeZone', 'Get-Uptime', 'Get-EventLog -LogName Application -Newest 1 | Format-List TimeGenerated', 'Get-ChildItem C:\\ | Select-Object -First 3 | Format-Table Name,LastWriteTime', 'Get-Process | Select-Object -First 2 | Format-Table Name,StartTime', 'Get-ScheduledTask | Select-Object -First 2 | Get-ScheduledTaskInfo', '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime', 'Get-LocalUser Administrator | Format-List LastLogon,PasswordLastSet', '[DateTime]::Now.ToString("o")', '[DateTimeOffset]::Now.ToString()', '(Get-Date).Hour', 'Get-Service | Select-Object -First 1', '[TimeZoneInfo]::Local.Id'];

async function run(tz: string): Promise<string[]> {
  process.env.TZ = tz;
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: Date.UTC(2026, 9, 6, 18, 25, 0) }));
  const pc = new WindowsPC('windows-pc', 'W1');
  await clock.advance(3 * 3600_000 + 17 * 60_000);
  const out: string[] = [];
  for (const c of CMD) out.push(await pc.executeCommand(c));
  const ps = PowerShellSubShell.create(pc).subShell;
  for (const c of PS) out.push((await ps.processLine(c)).output.join('\n'));
  __resetSimulationClock();
  return out;
}

it('win tz leak', async () => {
  const names = [...CMD, ...PS];
  const a = await run('UTC');
  const b = await run('Pacific/Auckland');
  process.env.TZ = 'UTC';
  names.forEach((c, i) => { if (a[i] !== b[i]) console.log('LEAK', c, '\n--UTC--\n' + a[i] + '\n--AKL--\n' + b[i]); });
  console.log('LEAK count', names.filter((_, i) => a[i] !== b[i]).length, 'of', names.length);
  names.forEach((c, i) => console.log('SAMPLE', c, '=>', JSON.stringify(a[i]).slice(0, 160)));
});
