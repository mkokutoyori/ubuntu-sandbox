/**
 * Mesure de depart : sans `bgp router-id`, un routeur Cisco annoncait « BGP router identifier
 * 0.0.0.0 » (`show ip bgp summary`), « local router ID is 0.0.0.0 » (`show ip bgp`) et, sur
 * Huawei, « BGP local router ID : 0.0.0.0 » — alors que le moteur EIGRP du MEME routeur elisait
 * deja 1.1.1.1 (`show ip eigrp topology` : `ID(1.1.1.1)`). Un routeur reel elit l'identifiant de
 * la plus haute adresse de loopback, a defaut de la plus haute adresse d'interface (RFC 4271 §4.2 :
 * « BGP Identifier » est un entier de 4 octets propre au routeur, jamais nul), et le moteur BGP
 * posait ce 0.0.0.0 dans son OPEN. Trois implantations de l'election existaient ou manquaient
 * (OSPF, EIGRP, rien pour BGP) : elles partagent maintenant `electRouterId`.
 *
 * Laboratoire : un CiscoRouter et un HuaweiRouter, une loopback 1.1.1.1/32 et une interface
 * 10.0.0.1/24 chacun, BGP configure sans identifiant explicite, EIGRP aussi. Sur les sept cas,
 * quatre tombent avant la correction (BGP summary, BGP table, EIGRP `show eigrp protocols`,
 * Huawei) ; trois passent dans les deux etats : le TEMOIN EIGRP topology (election deja correcte),
 * la NON-REGRESSION `bgp router-id 9.9.9.9`, qui doit rester maitre, et l'unite `electRouterId`
 * (fonction nouvelle, donc sans etat « avant »).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { electRouterId } from '@/network/routing/RouterIdElection';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => { for (const c of cmds) await d.executeCommand(c); };

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function cisco(extra: string[] = []): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', 0, 0);
  await run(r, ['enable', 'configure terminal',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', ...extra, 'exit',
    'router eigrp 100', 'network 10.0.0.0 0.0.0.255', 'end']);
  return r;
}

describe('router identifier of BGP and EIGRP', () => {
  it('witness: the EIGRP topology table already shows the elected identifier', async () => {
    expect(await (await cisco()).executeCommand('show ip eigrp topology')).toContain('ID(1.1.1.1)');
  });

  it('show ip bgp summary shows the highest loopback address', async () => {
    const first = (await (await cisco()).executeCommand('show ip bgp summary')).split('\n')[0];
    expect(first).toBe('BGP router identifier 1.1.1.1, local AS number 65001');
  });

  it('show ip bgp shows it as the local router ID', async () => {
    expect((await (await cisco()).executeCommand('show ip bgp')).split('\n')[0])
      .toBe('BGP table version is 1, local router ID is 1.1.1.1');
  });

  it('show eigrp protocols shows the same Router-ID as the topology table', async () => {
    expect(await (await cisco()).executeCommand('show eigrp protocols')).toContain('Router-ID: 1.1.1.1');
  });

  it('an explicit bgp router-id stays master', async () => {
    const r = await cisco(['bgp router-id 9.9.9.9']);
    expect((await r.executeCommand('show ip bgp summary')).split('\n')[0])
      .toBe('BGP router identifier 9.9.9.9, local AS number 65001');
  });

  it('display bgp peer on a Huawei router shows the elected identifier', async () => {
    const h = new HuaweiRouter('H1', 0, 0);
    await run(h, ['system-view', 'interface LoopBack0', 'ip address 1.1.1.1 32', 'quit',
      'bgp 65001', 'peer 10.0.0.2 as-number 65002', 'quit']);
    expect((await h.executeCommand('display bgp peer')).split('\n')[0]).toBe('BGP local router ID : 1.1.1.1');
  });
});

describe('electRouterId', () => {
  it('prefers a loopback over a higher interface address, else the highest address', () => {
    expect(electRouterId([{ iface: 'GigabitEthernet0/0', ip: '10.0.0.1' }, { iface: 'Loopback0', ip: '1.1.1.1' }]))
      .toBe('1.1.1.1');
    expect(electRouterId([{ iface: 'GigabitEthernet0/0', ip: '10.0.0.1' }, { iface: 'GigabitEthernet0/1', ip: '9.0.0.1' }]))
      .toBe('10.0.0.1');
    expect(electRouterId([])).toBeNull();
  });
});
