import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const INVALID = "% Invalid input detected at '^' marker.";
const INCOMPLETE = '% Incomplete command.';

async function router(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

describe('Cisco OSPF config-router — argument validation', () => {
  it('rejects an invalid router-id', async () => {
    const r = await router();
    await r.executeCommand('router ospf 1');
    expect(await r.executeCommand('router-id 999.1.1.1')).toBe(INVALID);
    expect(await r.executeCommand('router-id')).toBe(INCOMPLETE);
    expect(await r.executeCommand('router-id 1.1.1.1')).toBe('');
  });

  it('rejects an unknown redistribution protocol', async () => {
    const r = await router();
    await r.executeCommand('router ospf 1');
    expect(await r.executeCommand('redistribute bogus')).toBe(INVALID);
    expect(await r.executeCommand('redistribute')).toBe(INCOMPLETE);
    expect(await r.executeCommand('redistribute static')).toBe('');
    expect(await r.executeCommand('redistribute connected')).toBe('');
  });
});

describe('Cisco EIGRP/BGP config-router — argument validation', () => {
  it('rejects an invalid router-id for EIGRP', async () => {
    const r = await router();
    await r.executeCommand('router eigrp 100');
    expect(await r.executeCommand('router-id 999.1.1.1')).toBe(INVALID);
    expect(await r.executeCommand('router-id')).toBe(INCOMPLETE);
    expect(await r.executeCommand('router-id 2.2.2.2')).toBe('');
  });

  it('rejects an unknown redistribution protocol for EIGRP', async () => {
    const r = await router();
    await r.executeCommand('router eigrp 100');
    expect(await r.executeCommand('redistribute bogus')).toBe(INVALID);
    expect(await r.executeCommand('redistribute')).toBe(INCOMPLETE);
    expect(await r.executeCommand('redistribute static')).toBe('');
  });

  it('rejects an invalid router-id for BGP', async () => {
    const r = await router();
    await r.executeCommand('router bgp 65000');
    expect(await r.executeCommand('router-id 300.1.1.1')).toBe(INVALID);
    expect(await r.executeCommand('router-id 3.3.3.3')).toBe('');
  });

  it('validates BGP neighbor arguments without crashing convergence', async () => {
    const r = await router();
    await r.executeCommand('router bgp 65000');
    expect(await r.executeCommand('neighbor')).toBe(INCOMPLETE);
    expect(await r.executeCommand('neighbor 1.1.1.1')).toBe(INCOMPLETE);
    expect(await r.executeCommand('neighbor 999.1.1.1 remote-as 100')).toBe(INVALID);
    expect(await r.executeCommand('neighbor 1.1.1.1 remote-as')).toBe(INCOMPLETE);
    expect(await r.executeCommand('neighbor 1.1.1.1 remote-as abc')).toBe(INVALID);
    expect(await r.executeCommand('neighbor 1.1.1.1 remote-as 100')).toBe('');
  });

  it('still supports BGP peer-group definitions by name', async () => {
    const r = await router();
    await r.executeCommand('router bgp 65000');
    expect(await r.executeCommand('neighbor IBGP peer-group')).toBe('');
    expect(await r.executeCommand('neighbor 10.0.0.10 peer-group IBGP')).toBe('');
  });

  it('rejects an invalid EIGRP/BGP network statement', async () => {
    const r = await router();
    await r.executeCommand('router eigrp 100');
    expect(await r.executeCommand('network')).toBe(INCOMPLETE);
    expect(await r.executeCommand('network 999.0.0.0')).toBe(INVALID);
    expect(await r.executeCommand('network 10.0.0.0')).toBe('');
  });
});
