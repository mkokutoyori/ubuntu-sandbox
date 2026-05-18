/**
 * TDD — Huawei VRP router `display interface [brief|description|<if>]`
 * must reflect REAL port state (mirrors the Cisco show interfaces
 * real-state work). No "Invalid input", no fabricated data.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Huawei router display interface family (real state)', () => {
  it('display interface (all) reflects configured IP', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 192.168.9.1 255.255.255.0');
    await r.executeCommand('description UPLINK-H');
    await r.executeCommand('undo shutdown');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const all = await r.executeCommand('display interface');
    expect(all).not.toMatch(/Invalid input|Incomplete/);
    expect(all).toContain('GE0/0/0');
    expect(all).toContain('192.168.9.1');

    const brief = await r.executeCommand('display interface brief');
    expect(brief).not.toMatch(/Invalid input/);
    expect(brief).toContain('GE0/0/0');

    const desc = await r.executeCommand('display interface description');
    expect(desc).not.toMatch(/Invalid input/);
    expect(desc).toContain('UPLINK-H');
  });

  it('per-interface still works and bare forms are not "Incomplete"', async () => {
    const r = new HuaweiRouter('R1');
    expect(await r.executeCommand('display interface GE0/0/0'))
      .not.toMatch(/Invalid input|Incomplete command/);
    expect(await r.executeCommand('display interface'))
      .not.toMatch(/Incomplete command/);
  });
});
