/**
 * Probe — a pipeline typed through `powershell "<script>"` from cmd.exe runs every stage.
 *
 * Measured: `powershell "Get-Service | Select-Object -First 1 | Format-List *"`
 * printed the table of every service, because the cmd shim evaluated the head of
 * the pipeline and dropped any stage other than Select-String. The statement is
 * now handed whole to the PowerShell engine when its head belongs to PowerShell
 * and a stage other than Select-String follows; the Select-String shortcut and
 * cmd heads (`ipconfig | ...`) keep their path.
 *
 * Discrimination on the base: 3 of 4 fall (First 1, Format-List layout, Measure-Object).
 * The witness (Select-String filtering) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'win1', 0, 0);
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  return pc;
}

describe('cmd -> powershell pipelines', () => {
  it('Select-Object -First 1 keeps one service', async () => {
    const out = await lab().executeCommand('powershell "Get-Service | Select-Object -First 1 | Format-List *"');
    expect(out.match(/^Name\s*:/gm)?.length).toBe(1);
  });

  it('Format-List renders the property list, not a table', async () => {
    const out = await lab().executeCommand('powershell "Get-Service | Select-Object -First 1 | Format-List *"');
    expect(out).toMatch(/^Status\s*:/m);
    expect(out).not.toMatch(/^-{4,}/m);
  });

  it('Measure-Object counts the stage', async () => {
    const out = await lab().executeCommand('powershell "Get-Service | Measure-Object"');
    expect(out).toMatch(/^Count\s*:\s*\d+/m);
  });

  it('witness: Select-String still filters', async () => {
    const out = await lab().executeCommand('powershell "Get-Service | Select-String Spooler"');
    expect(out.split('\n').length).toBeLessThanOrEqual(3);
  });
});
