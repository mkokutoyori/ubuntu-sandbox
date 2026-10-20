/*
 * A Windows host emits syslog with Send-SyslogMessage (the Posh-SYSLOG cmdlet surface) over real frames: UDP datagrams
 * and TCP streams cross the switch to a Linux rsyslog collector, are parsed by the ported engine (RFC 5424 and RFC 3164,
 * octet-counted framing) and land in the collector's files. Windows Event Log entries written through either interface
 * (eventcreate in cmd, Write-EventLog in PowerShell) are read back by Get-WinEvent and forwarded by the same cmdlet.
 * Before the cmdlet existed (the commit preceding it), 5 of the 6 cases fall: every one that calls Send-SyslogMessage. The one
 * that passes either way is the WITNESS for the Event Log: Write-EventLog read back by wevtutil, which proves the store is
 * shared and that the forwarded entry of the eventcreate case is not an artefact of the lab.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function lab(): Promise<{ windows: WindowsPC; collector: LinuxServer; shell: ReturnType<typeof PowerShellSubShell.create>['subShell'] }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN-LAB', 0, 0);
  const collector = new LinuxServer('linux-server', 'collector', 0, 0);
  [windows, collector].forEach((device, index) => new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]));
  windows.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  collector.getPorts()[0].configureIP(new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));
  [windows, collector, sw].forEach((device) => device.powerOn());
  await collector.executeCommand("sed -i 's/^#module(load=\"imudp\")/module(load=\"imudp\")/;s/^#input(type=\"imudp\" port=\"514\")/input(type=\"imudp\" port=\"514\")/;s/^#module(load=\"imtcp\")/module(load=\"imtcp\")/;s/^#input(type=\"imtcp\" port=\"514\")/input(type=\"imtcp\" port=\"514\")/' /etc/rsyslog.conf");
  await collector.executeCommand('systemctl restart rsyslog');
  return { windows, collector, shell: PowerShellSubShell.create(windows).subShell };
}

const run = async (shell: Awaited<ReturnType<typeof lab>>['shell'], line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');

describe('Send-SyslogMessage over the wire', () => {
  it('an RFC 5424 datagram is filed by the collector under the Windows host name', async () => {
    const { collector, shell } = await lab();
    const framesIn = (): number => collector.getPorts()[0].getCounters().framesIn;
    const before = framesIn();
    const out = await run(shell, 'Send-SyslogMessage -Server 10.0.0.50 -Message "disk almost full" -Severity Warning -Facility Local4 -ApplicationName backup');
    expect(out).toBe('');
    expect(framesIn()).toBeGreaterThan(before);
    expect(await collector.executeCommand('grep "disk almost full" /var/log/syslog')).toMatch(/WIN-LAB backup.*disk almost full/);
  }, 60_000);

  it('-Rfc3164 sends the BSD format; the priority decides which file the rule keeps', async () => {
    const { collector, shell } = await lab();
    await run(shell, 'Send-SyslogMessage -Server 10.0.0.50 -Message "login failed" -Severity Error -Facility Auth -ApplicationName winlogon -Rfc3164');
    expect(await collector.executeCommand('cat /var/log/auth.log')).toContain('winlogon: login failed');
    expect(await collector.executeCommand('grep -c "login failed" /var/log/syslog')).toBe('0');
  }, 60_000);

  it('TCP with octet counting reaches imtcp; a closed port is an error, not a silent success', async () => {
    const { collector, shell } = await lab();
    expect(await run(shell, 'Send-SyslogMessage -Server 10.0.0.50 -Message "over tcp" -Transport TCP')).toBe('');
    expect(await collector.executeCommand('grep "over tcp" /var/log/syslog')).toContain('over tcp');
    await collector.executeCommand('systemctl stop rsyslog');
    expect(await run(shell, 'Send-SyslogMessage -Server 10.0.0.50 -Message "nobody home" -Transport TCP')).toContain('actively refused');
  }, 60_000);

  it('an unknown severity is refused with the parameter-validation wording', async () => {
    const { shell } = await lab();
    expect(await run(shell, 'Send-SyslogMessage -Server 10.0.0.50 -Message x -Severity Loud')).toContain("Cannot validate argument on parameter 'Severity'");
  }, 60_000);
});

describe('the Event Log is one store behind two interfaces', () => {
  it('an entry written by eventcreate (cmd) is forwarded by the pipeline', async () => {
    const { windows, collector, shell } = await lab();
    await windows.executeCommand('eventcreate /T WARNING /ID 501 /L APPLICATION /SO LabApp /D "queue depth above threshold"');
    const forwarded = await run(shell, 'Get-WinEvent -LogName Application -MaxEvents 5 | Where-Object { $_.Id -eq 501 } | ForEach-Object { Send-SyslogMessage -Server 10.0.0.50 -Message $_.Message -ApplicationName LabApp -Severity Warning }');
    expect(forwarded).toBe('');
    expect(await collector.executeCommand('grep "queue depth above threshold" /var/log/syslog')).toContain('WIN-LAB LabApp');
  }, 60_000);

  it('an entry written by Write-EventLog (PowerShell) is read back by wevtutil (cmd)', async () => {
    const { windows, shell } = await lab();
    await run(shell, 'New-EventLog -LogName Application -Source LabTool');
    await run(shell, 'Write-EventLog -LogName Application -Source LabTool -EventId 777 -EntryType Information -Message "nightly job done"');
    expect(await windows.executeCommand('wevtutil qe Application /c:5 /rd:true /f:text')).toContain('nightly job done');
  }, 60_000);
});
