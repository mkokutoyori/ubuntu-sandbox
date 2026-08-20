import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function inSystem(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('AR1');
  await r.executeCommand('system-view');
  return r;
}

async function inInterface(): Promise<HuaweiRouter> {
  const r = await inSystem();
  await r.executeCommand('interface GigabitEthernet 0/0/0');
  return r;
}

describe('VRP announces the type of a consumed argument too', () => {
  it.each([
    ['ip address ?', 'A.B.C.D'],
    ['description ?', 'LINE'],
  ])('%s announces %s in the interface view', async (command, expected) => {
    const r = await inInterface();
    expect(await r.executeCommand(command)).toContain(expected);
  });

  it.each([
    ['sysname ?', 'WORD'],
    ['ip route-static ?', 'A.B.C.D'],
    ['ospf ?', '<1-65535>'],
  ])('%s announces %s in the system view', async (command, expected) => {
    const r = await inSystem();
    expect(await r.executeCommand(command)).toContain(expected);
  });

  it('ip address <address> ? announces the mask, as VRP does', async () => {
    const r = await inInterface();
    const help = await r.executeCommand('ip address 192.168.1.1 ?');
    expect(help).toContain('A.B.C.D');
    expect(help).toContain('Mask or mask-length');
  });

  it('a declared argument did not break the command it describes', async () => {
    const r = await inInterface();
    expect(await r.executeCommand('ip address 192.168.1.1 255.255.255.0'))
      .not.toMatch(/Error|Unrecognized|Incomplete/);
    expect(await r.executeCommand('description UPLINK'))
      .not.toMatch(/Error|Unrecognized|Incomplete/);
    await r.executeCommand('quit');
    expect(await r.executeCommand('sysname AR-TEST'))
      .not.toMatch(/Error|Unrecognized|Incomplete/);
    expect(await r.executeCommand('ip route-static 10.0.0.0 255.0.0.0 192.168.1.2'))
      .not.toMatch(/Error|Unrecognized|Incomplete/);
  });

  it('the declared ospf range is the one the command enforces', async () => {
    const r = await inSystem();
    const refused = (out: string) => /Error|Unrecognized|Incomplete|Invalid/.test(out);
    expect(refused(await r.executeCommand('ospf 0'))).toBe(true);
    expect(refused(await r.executeCommand('ospf 1'))).toBe(false);
    await r.executeCommand('quit');
    expect(refused(await r.executeCommand('ospf 65535'))).toBe(false);
    await r.executeCommand('quit');
    expect(refused(await r.executeCommand('ospf 65536'))).toBe(true);
  });

  it('the VRP help offers no keyword without a description', async () => {
    const r = await inInterface();
    const undescribed = (await r.executeCommand('?')).split('\n')
      .filter((l) => l.trim().length > 0 && !l.includes('<cr>'))
      .filter((l) => /^\s+\S+\s*$/.test(l));
    expect(undescribed).toEqual([]);
  });
});
