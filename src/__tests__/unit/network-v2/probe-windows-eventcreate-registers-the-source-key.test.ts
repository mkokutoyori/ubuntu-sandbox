/**
 * Probe — a source written by eventcreate is registered in the registry (New-EventLog is gone in PowerShell 7).
 *
 * Measured: after `eventcreate /l Application /so Billing`, the key
 * HKLM\SYSTEM\CurrentControlSet\Services\EventLog\Application\Billing did not exist
 * (Test-Path false), while the event log store knew the source: two views of
 * one fact (rule 3). The source is now registered through one hook of the event
 * log store; the registry key is created there, not copied by the cmdlet.
 *
 * Values of the key (rule 8): Microsoft (Aaron Margosis, "EventCreate and ERROR: Source parameter is used to identify custom applications/scripts only", Microsoft Learn archive):
 * EventCreate adds a REG_DWORD value CustomSource to the key of a source it creates, and refuses an existing source that lacks it with "ERROR: Source parameter is used to
 * identify custom applications/scripts only (not installed applications)." EventMessageFile is %SystemRoot%\System32\EventCreate.exe: the Windows EventCreate.exe is its own message
 * file (it holds the identity template for the identifiers 1 to 1001), which is what ReactOS's eventcreate.c documents and reproduces; this is a reimplementation's account, not a
 * Microsoft page, said here and in TODO.md. TypesSupported is "unused" per the Event Sources page and is not written.
 *
 * The machine's own providers (MsiInstaller, Service Control Manager...) have a key without CustomSource, written when they first write an event, so eventcreate refuses them as installed
 * applications.
 *
 * The EventMessageFile of the machine's own providers comes from the winevt-kb tables (libyal/winevt-kb, docs/sources/eventlog-providers), a forensic knowledge base built from real Windows
 * installations: the entry seen on Windows 10 and 11 of each provider (Service Control Manager: services.exe, MsiInstaller: msimsg.dll, SecurityCenter: wscsvc.dll, Tcpip and EventLog: netevent.dll,
 * Time-Service: w32time.dll, Security-Auditing: adtschema.dll, Kernel-General and Kernel-Boot: Microsoft-Windows-System-Events.dll). It is a third-party compilation, not a Microsoft page, and a
 * web search corrected a wrong recollection (netmsg.dll) before this was written. The Winlogon key is not filled: the real classic source is Winlogon in the Application log, not the one of the simulator.
 *
 * Discrimination (git stash push -- src/network src/powershell): the two provider cases fall on the previous commit (2 of 9), and CustomSource, EventMessageFile and the refusal on the one before; the key and its listing
 * fell on a base with no key at all. The WITNESS (the event log store knows the source) and the case that a source eventcreate created keeps working pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'win1', 0, 0);
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  await pc.executeCommand('eventcreate /l Application /so Billing /id 5 /t INFORMATION /d "first"');
  return pc;
}

describe('New-EventLog registers the source in the registry', () => {
  it('the source key exists', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('powershell -Command "Test-Path HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Billing"')).toContain('True');
  });

  it('Get-ChildItem lists the source under its log', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('powershell -Command "Get-ChildItem HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application"')).toContain('Billing');
  });

  it('witness: the event log store knows the source', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('powershell -Command "(Get-WinEvent -LogName Application).ProviderName"')).toContain('Billing');
  });

  it('the key carries CustomSource as a DWORD of 1', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('powershell -Command "(Get-ItemProperty HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Billing).CustomSource"');
    expect(out.trim()).toBe('1');
  });

  it('the key carries EventMessageFile, the EventCreate executable', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('powershell -Command "(Get-ItemProperty HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Billing).EventMessageFile"');
    expect(out.trim()).toBe('%SystemRoot%\\System32\\EventCreate.exe');
  });

  it('refuses a source whose key lacks CustomSource, as an installed application', async () => {
    const pc = await lab();
    await pc.executeCommand('powershell -Command "New-Item HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Installed -Force | Out-Null"');
    const out = await pc.executeCommand('eventcreate /l Application /so Installed /id 6 /t INFORMATION /d "no"');
    expect(out).toContain('ERROR: Source parameter is used to identify custom applications/scripts only (not installed applications).');
  });

  it('a source eventcreate created keeps accepting events', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('eventcreate /l Application /so Billing /id 7 /t INFORMATION /d "second"');
    expect(out).toContain('SUCCESS');
  });

  it('a provider of the machine has a key without CustomSource, and eventcreate refuses it as installed', async () => {
    const pc = await lab();
    const key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\MsiInstaller';
    expect((await pc.executeCommand(`powershell -Command "Test-Path ${key}"`))).toContain('True');
    expect((await pc.executeCommand(`powershell -Command "(Get-ItemProperty ${key}).CustomSource"`)).trim()).toBe('');
    expect(await pc.executeCommand('eventcreate /l Application /so MsiInstaller /id 8 /t INFORMATION /d "no"')).toContain('not installed applications');
  });

  it('a provider that writes later (a service control) gets its key too', async () => {
    const pc = await lab();
    await pc.executeCommand('powershell -Command "Restart-Service Spooler"');
    const out = await pc.executeCommand(`powershell -Command "Test-Path -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\System\\Service Control Manager'"`);
    expect(out).toContain('True');
  });

  it('the machine\'s own providers carry the message file the winevt-kb tables record for Windows 10 and 11', async () => {
    const pc = await lab();
    await pc.executeCommand('powershell -Command "Restart-Service Spooler"');
    const read = (log: string, source: string): Promise<string> =>
      pc.executeCommand(`powershell -Command "(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\${log}\\${source}').EventMessageFile"`);
    const expected: Array<[string, string, string]> = [
      ['System', 'Service Control Manager', '%SystemRoot%\\system32\\services.exe'],
      ['Application', 'MsiInstaller', '%SystemRoot%\\system32\\msimsg.dll'],
      ['Application', 'SecurityCenter', '%SystemRoot%\\System32\\wscsvc.dll'],
      ['System', 'Tcpip', '%SystemRoot%\\System32\\netevent.dll'],
      ['System', 'Microsoft-Windows-Time-Service', '%SystemRoot%\\system32\\w32time.dll'],
      ['Security', 'Microsoft-Windows-Security-Auditing', '%SystemRoot%\\system32\\adtschema.dll'],
    ];
    for (const [log, source, file] of expected) expect((await read(log, source)).trim()).toBe(file);
  });
});
