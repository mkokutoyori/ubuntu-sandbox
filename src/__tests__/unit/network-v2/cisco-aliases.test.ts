/**
 * TDD — Lot C: real CLI alias subsystem (AliasRepository).
 * `alias exec …` creates a WORKING alias (typing it runs the real
 * command) and `show aliases` projects real state. IOS default exec
 * aliases are present. Shared switch + router (DRY).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { AliasRepository } from '@/network/devices/inspection/config/AliasRepository';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('AliasRepository (unit)', () => {
  it('resolves user aliases over defaults and lists them', () => {
    const a = new AliasRepository();
    expect(a.resolve('exec', 's')).toBe('show');        // IOS default
    a.set('exec', 'sib', 'show ip interface brief');
    expect(a.resolve('exec', 'sib')).toBe('show ip interface brief');
    expect(a.resolve('exec', 'nope')).toBeNull();
    expect(a.render()).toContain('sib');
    expect(a.render()).toContain('Exec mode aliases:');
    expect(a.remove('exec', 'sib')).toBe(true);
    expect(a.resolve('exec', 'sib')).toBeNull();
  });
});

describe('Cisco alias subsystem (router & switch, real)', () => {
  it('router: alias exec creates a working alias', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('alias exec sib show ip interface brief'))
      .not.toMatch(/Invalid input|Incomplete/);
    await r.executeCommand('end');

    const viaAlias = await r.executeCommand('sib');
    const direct = await r.executeCommand('show ip interface brief');
    expect(viaAlias).toBe(direct);
    expect(viaAlias).not.toMatch(/Invalid input/);

    const aliases = await r.executeCommand('show aliases');
    expect(aliases).toContain('sib');
    expect(aliases).toMatch(/show ip interface brief/);

    await r.executeCommand('configure terminal');
    await r.executeCommand('no alias exec sib');
    await r.executeCommand('end');
    expect(await r.executeCommand('sib')).toMatch(/Invalid input|Incomplete|Unrecognized/);
  });

  it('router: IOS default exec alias s expands to show', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    const viaS = await r.executeCommand('s ip route');
    const direct = await r.executeCommand('show ip route');
    expect(viaS).toBe(direct);
  });

  it('switch: alias subsystem works identically (DRY)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('alias exec sv show version');
    await sw.executeCommand('end');
    const viaAlias = await sw.executeCommand('sv');
    const direct = await sw.executeCommand('show version');
    expect(viaAlias).toBe(direct);
    expect(await sw.executeCommand('show aliases')).toContain('sv');
  });
});
