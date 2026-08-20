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

function entryOf(r: HuaweiRouter, map: string, seq: number) {
  return r._getIPSecEngineInternal()!.getOrCreateCryptoMapEntry(map, seq);
}

describe('Huawei ike-peer NAME binds the crypto map to the peer IP, not the name', () => {
  it('peer configured before the policy binding — the entry holds the remote IP', async () => {
    const r = new HuaweiRouter('R1');
    for (const cmd of [
      'system-view',
      'ike peer BRANCH', 'remote-address 203.0.113.2', 'pre-shared-key simple secret', 'quit',
      'ipsec proposal PROP', 'quit',
      'ipsec policy VPN 10 isakmp', 'ike-peer BRANCH', 'proposal PROP', 'quit',
    ]) await r.executeCommand(cmd);

    const entry = entryOf(r, 'VPN', 10);
    expect(entry.peers).toEqual(['203.0.113.2']);
    expect(entry.ikePeerName).toBe('BRANCH');
  });

  it('policy binding before remote-address — the entry re-homes once the address is set', async () => {
    const r = new HuaweiRouter('R1');
    for (const cmd of [
      'system-view',
      'ike peer BRANCH', 'quit',
      'ipsec policy VPN 10 isakmp', 'ike-peer BRANCH', 'quit',
      'ike peer BRANCH', 'remote-address 203.0.113.2', 'quit',
    ]) await r.executeCommand(cmd);

    const entry = entryOf(r, 'VPN', 10);
    expect(entry.peers).toEqual(['203.0.113.2']);
  });

  it('the name never leaks into the peers list while the address is unknown', async () => {
    const r = new HuaweiRouter('R1');
    for (const cmd of [
      'system-view',
      'ike peer BRANCH', 'quit',
      'ipsec policy VPN 10 isakmp', 'ike-peer BRANCH', 'quit',
    ]) await r.executeCommand(cmd);

    const entry = entryOf(r, 'VPN', 10);
    expect(entry.peers).toEqual([]);
    expect(entry.ikePeerName).toBe('BRANCH');
  });

  it('display current-configuration keeps showing the peer NAME, not the resolved IP', async () => {
    const r = new HuaweiRouter('R1');
    for (const cmd of [
      'system-view',
      'ike peer BRANCH', 'remote-address 203.0.113.2', 'quit',
      'ipsec policy VPN 10 isakmp', 'ike-peer BRANCH', 'quit',
      'return',
    ]) await r.executeCommand(cmd);

    const out = await r.executeCommand('display current-configuration');
    expect(out).toContain('ike-peer BRANCH');
    expect(out).not.toContain('ike-peer 203.0.113.2');
  });
});
