/**
 * Probe — a source written by eventcreate is registered in the registry (New-EventLog is gone in PowerShell 7).
 *
 * Measured: after `eventcreate /l Application /so Billing`, the key
 * HKLM\SYSTEM\CurrentControlSet\Services\EventLog\Application\Billing did not exist
 * (Test-Path false), while the event log store knew the source: two views of
 * one fact (rule 3). The source is now registered through one hook of the event
 * log store; the registry key is created there, not copied by the cmdlet.
 *
 * Discrimination on the base: 2 of 3 fall (key present; Get-ChildItem lists the
 * source). The witness (the source is known to Get-WinEvent -ListProvider) passes
 * either way. Authority: the key layout is the documented EventLog service
 * registration; the key's values (EventMessageFile) are not modelled and come
 * from no readable source here.
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
});
