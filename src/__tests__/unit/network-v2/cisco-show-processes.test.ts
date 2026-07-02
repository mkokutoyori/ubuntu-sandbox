import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Cisco show processes', () => {
  let r: CiscoRouter;
  beforeEach(() => { EquipmentRegistry.resetInstance(); r = new CiscoRouter('R1'); });

  it('SP-01 bare "show processes" lists the process table', async () => {
    await r.executeCommand('enable');
    const out = await r.executeCommand('show processes');
    expect(out).toContain('CPU utilization for five seconds');
    expect(out).toContain('Process');
    expect(out).toContain('Chunk Manager');
  });

  it('SP-02 "show processes cpu" still works', async () => {
    await r.executeCommand('enable');
    expect(await r.executeCommand('show processes cpu')).toContain('CPU utilization for five seconds');
  });

  it('SP-03 "show processes memory" still works', async () => {
    await r.executeCommand('enable');
    const out = await r.executeCommand('show processes memory');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/Invalid input/);
  });
});
