/**
 * PRD-Routage-Fidelite.md §4.2 / §6.5 — la RIB, la FIB, la passerelle de
 * dernier recours et le resume comptent la meme table. Les vues sont
 * comparees entre elles, jamais a une chaine ecrite a la main.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function run(dev: CiscoRouter, cmds: string[]): Promise<void> {
  for (const c of cmds) await dev.executeCommand(c);
}

function ribPrefixes(showIpRoute: string): string[] {
  return showIpRoute
    .split('\n')
    .map((l) => /^([A-Z][A-Za-z0-9*\s]*?)\s+(\d+\.\d+\.\d+\.\d+\/\d+)\s/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .filter((m) => m[1].trim() !== 'L')
    .map((m) => m[2]);
}

function fibPrefixes(showIpCef: string): string[] {
  return showIpCef
    .split('\n')
    .slice(1)
    .filter((l) => !/\bno route\b/.test(l))
    .map((l) => /^(\d+\.\d+\.\d+\.\d+\/\d+)\s/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[1]);
}

function summaryTotal(showSummary: string): number {
  const m = /^Total\s+(\d+)/m.exec(showSummary);
  return m ? Number(m[1]) : -1;
}

async function lab(): Promise<{ r: CiscoRouter; up: CiscoRouter; spare: CiscoRouter }> {
  const r = new CiscoRouter('R1');
  const up = new CiscoRouter('R2');
  const spare = new CiscoRouter('R3');
  new Cable('c1').connect(r.getPorts()[0], up.getPorts()[0]);
  await run(up, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']);
  await run(spare, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']);
  await run(r, [
    'enable',
    'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 10.0.12.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface GigabitEthernet0/1',
    'ip address 172.16.1.1 255.255.255.0',
    'no shutdown',
    'exit',
    'ip route 192.168.50.0 255.255.255.0 10.0.12.2',
    'ip route 192.168.53.0 255.255.255.0 Null0',
    'ip route 192.168.60.0 255.255.255.0 10.0.99.99',
    'ip route 192.168.70.0 255.255.255.0 172.16.1.2',
    'ip route 0.0.0.0 0.0.0.0 10.0.12.2',
    'ip route 0.0.0.0 0.0.0.0 172.16.1.2 250',
    'end',
  ]);
  return { r, up, spare };
}

describe('RIB and FIB are one table', () => {
  it('every prefix the RIB installs is in the FIB, and nothing else is', async () => {
    const { r } = await lab();
    const rib = ribPrefixes(await r.executeCommand('show ip route'));
    const fib = fibPrefixes(await r.executeCommand('show ip cef'));
    expect(fib.length).toBeGreaterThan(0);
    expect([...fib].sort()).toEqual([...rib].sort());
  });

  it('show ip route summary counts the table the views show', async () => {
    const { r } = await lab();
    const fib = fibPrefixes(await r.executeCommand('show ip cef'));
    expect(summaryTotal(await r.executeCommand('show ip route summary'))).toBe(fib.length);
  });

  it('a static route whose next hop no interface can resolve is configured but not installed', async () => {
    const { r } = await lab();
    expect(await r.executeCommand('show running-config')).toContain('ip route 192.168.60.0 255.255.255.0 10.0.99.99');
    expect(ribPrefixes(await r.executeCommand('show ip route'))).not.toContain('192.168.60.0/24');
    expect(fibPrefixes(await r.executeCommand('show ip cef'))).not.toContain('192.168.60.0/24');
  });

  it('a static route out of a down interface is configured but not installed', async () => {
    const { r } = await lab();
    expect(await r.executeCommand('show ip interface brief')).toMatch(/GigabitEthernet0\/1\s+172\.16\.1\.1\s+YES manual down\s+down/);
    expect(ribPrefixes(await r.executeCommand('show ip route'))).not.toContain('192.168.70.0/24');
    expect(ribPrefixes(await r.executeCommand('show ip route'))).not.toContain('172.16.1.0/24');
  });

  it('cabling the down interface installs its routes in every view at once', async () => {
    const { r, spare } = await lab();
    new Cable('c2').connect(r.getPorts()[1], spare.getPorts()[0]);
    const rib = ribPrefixes(await r.executeCommand('show ip route'));
    const fib = fibPrefixes(await r.executeCommand('show ip cef'));
    expect(rib).toContain('172.16.1.0/24');
    expect(rib).toContain('192.168.70.0/24');
    expect([...fib].sort()).toEqual([...rib].sort());
    expect(summaryTotal(await r.executeCommand('show ip route summary'))).toBe(fib.length);
  });

  it('Null0 is an interface, not a next hop', async () => {
    const { r } = await lab();
    expect(await r.executeCommand('show ip route')).toContain('192.168.53.0/24 [1/0] is directly connected, Null0');
    expect(await r.executeCommand('show ip cef')).toMatch(/192\.168\.53\.0\/24\s+attached\s+Null0/);
  });

  it('only the best default route is installed, and it is the gateway of last resort', async () => {
    const { r } = await lab();
    const route = await r.executeCommand('show ip route');
    expect(ribPrefixes(route).filter((p) => p === '0.0.0.0/0')).toHaveLength(1);
    expect(fibPrefixes(await r.executeCommand('show ip cef')).filter((p) => p === '0.0.0.0/0')).toHaveLength(1);
    expect(route).toContain('Gateway of last resort is 10.0.12.2 to network 0.0.0.0');
    expect(route).toMatch(/S\*\s+0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.12\.2/);
    expect(await r.executeCommand('show ip cef')).not.toContain('no route');
  });

  it('CEF says "no route" exactly when the table has no default', async () => {
    const { r } = await lab();
    await run(r, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    expect(await r.executeCommand('show ip route')).toContain('Gateway of last resort is not set');
    expect(await r.executeCommand('show ip cef')).toContain('0.0.0.0/0            no route');
  });

  it('shutting the interface takes the whole family out of every view together', async () => {
    const { r } = await lab();
    await run(r, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    const rib = ribPrefixes(await r.executeCommand('show ip route'));
    const fib = fibPrefixes(await r.executeCommand('show ip cef'));
    expect(rib).not.toContain('10.0.12.0/24');
    expect(rib).not.toContain('192.168.50.0/24');
    expect(rib).not.toContain('0.0.0.0/0');
    expect([...fib].sort()).toEqual([...rib].sort());
    expect(await r.executeCommand('show ip route')).toContain('Gateway of last resort is not set');
    expect(summaryTotal(await r.executeCommand('show ip route summary'))).toBe(fib.length);
  });

  it('show ip cef honours a prefix argument', async () => {
    const { r } = await lab();
    const one = await r.executeCommand('show ip cef 192.168.50.0');
    expect(fibPrefixes(one)).toEqual(['192.168.50.0/24']);
  });
});
