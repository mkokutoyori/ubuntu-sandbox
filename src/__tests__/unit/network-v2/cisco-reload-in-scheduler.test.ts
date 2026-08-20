import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

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

describe('reload in — actually fires the reboot when the timer elapses', () => {
  let sched: VirtualTimeScheduler;
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    sched = new VirtualTimeScheduler();
    __setDefaultScheduler(sched);
  });
  afterEach(() => { __setDefaultScheduler(null); });

  it('power-cycles the device after the scheduled delay', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('reload in 1');
    let off = 0; let on = 0;
    const origOff = r.powerOff.bind(r); const origOn = r.powerOn.bind(r);
    (r as unknown as { powerOff: () => void }).powerOff = () => { off++; return origOff(); };
    (r as unknown as { powerOn: () => void }).powerOn = () => { on++; return origOn(); };
    sched.advance(60_001);
    expect(off).toBe(1);
    expect(on).toBe(1);
    expect(r.getIsPoweredOn()).toBe(true);
  });

  it('reload cancel prevents the scheduled reboot', async () => {
    const r = new CiscoRouter('R2');
    await r.executeCommand('enable');
    await r.executeCommand('reload in 1');
    await r.executeCommand('reload cancel');
    let off = 0;
    const origOff = r.powerOff.bind(r);
    (r as unknown as { powerOff: () => void }).powerOff = () => { off++; return origOff(); };
    sched.advance(120_000);
    expect(off).toBe(0);
  });
});

