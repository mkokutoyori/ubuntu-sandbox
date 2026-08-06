/**
 * PRD-Routage-Fidelite.md §2.1 / §6.1 — l'invariant du chantier A.
 *
 * Ce que la configuration rend doit pouvoir etre retape tel quel et
 * produire le meme equipement. Le test boucle : configurer, serialiser,
 * REJOUER sur un routeur neuf par le chemin de l'import de topologie
 * (`replayVendorConfig`, pas une boucle ecrite pour l'occasion),
 * re-serialiser, comparer. Il n'enumere aucune commande : il compare
 * deux configurations.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { replayVendorConfig } from '@/store/topologySerializer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const ROUTING = [
  'router rip',
  'version 2',
  'network 172.16.0.0',
  'network 10.0.0.0',
  'passive-interface GigabitEthernet0/2',
  'redistribute ospf 1 metric 5',
  'redistribute connected',
  'end',
  'router ospf 1',
  'router-id 10.10.10.10',
  'network 192.168.100.0 0.0.0.255 area 0',
  'end',
  'router eigrp 100',
  'network 10.0.0.0',
  'no auto-summary',
  'end',
  'router bgp 65001',
  'bgp router-id 1.1.1.1',
  'neighbor 10.0.12.2 remote-as 65002',
  'network 192.168.1.0 mask 255.255.255.0',
  'redistribute static',
  'end',
  'ip prefix-list PL1 seq 5 permit 10.0.0.0/8',
  'route-map RM1 permit 10',
  'match ip address prefix-list PL1',
  'set metric 100',
  'end',
  'ip route 192.168.50.0 255.255.255.0 10.0.12.2',
];

let serial = 0;

async function freshRouter(): Promise<CiscoRouter> {
  const id = ++serial;
  const r = new CiscoRouter(`RT${id}`);
  const peer = new CiscoRouter(`PEER${id}`);
  new Cable(`cable${id}`).connect(r.getPorts()[0], peer.getPorts()[0]);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']) {
    await peer.executeCommand(c);
  }
  await r.executeCommand('enable');
  for (const c of ['configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'end']) {
    await r.executeCommand(c);
  }
  return r;
}

async function configure(r: CiscoRouter, lines: readonly string[]): Promise<string[]> {
  const refused: string[] = [];
  await r.executeCommand('configure terminal');
  for (const c of lines) {
    const out = await r.executeCommand(c);
    if (/% /.test(out)) refused.push(`${c} => ${out.trim()}`);
    if (c === 'end') await r.executeCommand('configure terminal');
  }
  await r.executeCommand('end');
  return refused;
}

/** Le corps, sans l'en-tete dont la taille en octets change avec le nom d'hote. */
function body(config: string): string[] {
  return config.split('\n').filter((l) =>
    l.trim() !== ''
    && !l.startsWith('Building configuration')
    && !l.startsWith('Current configuration')
    && !l.startsWith('hostname '));
}

async function roundTrip(lines: readonly string[]): Promise<{ first: string[]; second: string[] }> {
  const source = await freshRouter();
  await configure(source, lines);
  const first = await source.executeCommand('show running-config');
  const target = await freshRouter();
  await replayVendorConfig(target, first);
  const second = await target.executeCommand('show running-config');
  return { first: body(first), second: body(second) };
}

describe('a rendered configuration can be typed back', () => {
  it('replaying the whole routing configuration reproduces it exactly', async () => {
    const { first, second } = await roundTrip(ROUTING);
    expect(second).toEqual(first);
  });

  it('a second replay adds nothing — no declaration is stacked', async () => {
    const source = await freshRouter();
    await configure(source, ROUTING);
    const config = await source.executeCommand('show running-config');
    const target = await freshRouter();
    await replayVendorConfig(target, config);
    const once = body(await target.executeCommand('show running-config'));
    await replayVendorConfig(target, config);
    const twice = body(await target.executeCommand('show running-config'));
    expect(twice).toEqual(once);
  });

  it('every routing process appears exactly once', async () => {
    const source = await freshRouter();
    await configure(source, ROUTING);
    const config = await source.executeCommand('show running-config');
    for (const head of ['router rip', 'router ospf 1', 'router eigrp 100', 'router bgp 65001']) {
      const count = config.split('\n').filter((l) => l === head).length;
      expect(count, head).toBe(1);
    }
  });

  it('redistribute renders its source, not the command that carried it', async () => {
    const source = await freshRouter();
    await configure(source, ROUTING);
    const config = await source.executeCommand('show running-config');
    expect(config).not.toContain('redistribute redistribute');
    expect(config).toContain(' redistribute ospf 1 metric 5');
    expect(config).toContain(' redistribute connected');
  });

  it('a route-map clause renders its argument, not the command that carried it', async () => {
    const source = await freshRouter();
    await configure(source, ROUTING);
    const config = await source.executeCommand('show running-config');
    expect(config).not.toMatch(/match match|set set/);
    expect(config).toContain(' match ip address prefix-list PL1');
    expect(config).toContain(' set metric 100');
    expect(await source.executeCommand('show route-map')).toContain('    ip address prefix-list PL1');
  });

  it('route-maps and prefix-lists reach the configuration at all', async () => {
    const source = await freshRouter();
    await configure(source, ROUTING);
    const config = await source.executeCommand('show running-config');
    expect(config).toContain('ip prefix-list PL1 seq 5 permit 10.0.0.0/8');
    expect(config).toContain('route-map RM1 permit 10');
  });
});

describe('a routing process is identified by its number', () => {
  it('a non-numeric EIGRP identifier is refused, not turned into process 0', async () => {
    const r = await freshRouter();
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('router eigrp NAMED-AS')).toMatch(/Invalid input/);
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('router eigrp 0');
  });

  it('a second OSPF process is refused rather than merged into the first', async () => {
    const r = await freshRouter();
    await configure(r, ['router ospf 1', 'router-id 10.10.10.10', 'end']);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('router ospf 10 vrf CLIENT-A')).toMatch(/only one OSPF process/);
    await r.executeCommand('end');
    const config = await r.executeCommand('show running-config');
    expect(config).toContain('router ospf 1');
    expect(config).toContain(' router-id 10.10.10.10');
    expect(config).not.toContain('router ospf 10');
  });

  it('a second BGP AS is refused rather than erasing the first', async () => {
    const r = await freshRouter();
    await configure(r, ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002', 'end']);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('router bgp 65002')).toBe('% Currently a BGP peer to AS 65001');
    await r.executeCommand('end');
    const config = await r.executeCommand('show running-config');
    expect(config).toContain('router bgp 65001');
    expect(config).toContain(' neighbor 10.0.12.2 remote-as 65002');
    expect(config).not.toContain('router bgp 65002');
  });

  it('re-entering a process finds it again instead of replacing it', async () => {
    const r = await freshRouter();
    await configure(r, ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002', 'end',
      'router bgp 65001', 'network 192.168.1.0 mask 255.255.255.0', 'end']);
    const config = await r.executeCommand('show running-config');
    expect(config).toContain(' neighbor 10.0.12.2 remote-as 65002');
    expect(config).toContain(' network 192.168.1.0 mask 255.255.255.0');
  });
});

describe('OSPF normalises the network address against its wildcard', () => {
  it('the rendered network is stable when typed back', async () => {
    const { first, second } = await roundTrip([
      'router ospf 1', 'network 10.1.1.1 0.0.0.255 area 0',
      'network 172.16.3.0 255.255.255.0 area 0', 'end']);
    expect(first).toContain(' network 10.1.1.0 0.0.0.255 area 0');
    expect(first).toContain(' network 0.0.0.0 255.255.255.0 area 0');
    expect(second).toEqual(first);
  });
});
