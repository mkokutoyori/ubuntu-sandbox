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
 * Discrimination (git stash push -- src/network src/powershell): 3 of 7 cases fall on the previous commit (CustomSource, EventMessageFile, the refusal); the key and its listing
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
});
