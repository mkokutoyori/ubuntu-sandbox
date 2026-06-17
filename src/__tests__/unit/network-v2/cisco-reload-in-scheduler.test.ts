import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('reload in — scheduler-backed, correct grammar', () => {
  let r: CiscoRouter;
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    r = new CiscoRouter('R1');
  });

  it('uses singular "minute" for 1 and plural otherwise', async () => {
    await r.executeCommand('enable');
    expect(await r.executeCommand('reload in 1')).toContain('Reload scheduled in 1 minute');
    expect(await r.executeCommand('reload in 1')).not.toContain('1 minutes');
    expect(await r.executeCommand('reload in 3')).toContain('Reload scheduled in 3 minutes');
  });

  it('reload cancel clears the scheduled reload', async () => {
    await r.executeCommand('enable');
    await r.executeCommand('reload in 5');
    expect(await r.executeCommand('show reload')).toMatch(/Reload scheduled/);
    expect(await r.executeCommand('reload cancel')).toContain('Reload cancelled');
    expect(await r.executeCommand('show reload')).not.toMatch(/Reload scheduled in/);
  });
});
