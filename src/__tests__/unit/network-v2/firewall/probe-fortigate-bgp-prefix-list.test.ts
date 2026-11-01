/**
 * `config router bgp` / `config neighbor` : `set prefix-list-in` et `set prefix-list-out` (FortiOS CLI Reference 7.4.12) -- le filtre par liste de prefixes d'un voisin.
 * Le moteur BGP gagne deux crochets par voisin (`inboundAllows` a la reception d'un UPDATE, `outboundAllows` a l'annonce) que la FortiGate alimente avec ses listes
 * `router prefix-list` (une liste absente ou vide refuse tout, comme le refus implicite d'une liste). Changer le filtre d'un voisin remet sa session a zero,
 * comme un `clear` apres un changement de politique.
 * `router route-map` (regles : action, match-ip-address, set-local-preference, set-metric, set-weight ; les autres match-*/set-* de la reference sont refuses comme attributs inconnus faute de moteur) se branche sur `route-map-in` / `route-map-out` en reutilisant `RoutePolicy` du depot (premier noeud qui correspond, refus implicite) ; les crochets du moteur BGP rendent maintenant une decision (refus, ou LOCAL_PREF / poids / MED). Mesure de depart (prefix-list) : « unknown attribute » ; les 2 filtres des prefix-lists tombaient avant ; le temoin (sans filtre le Cisco recoit les deux reseaux) et le refus d'une liste inconnue (attribut inconnu avant) passent des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

interface BgpRow { network: { toString(): string }; localPref: number; weight: number }
const bgpRows = (firewall: FortiGate): BgpRow[] =>
  (firewall as unknown as { getRouting(): { getBgp(): { getEngine(): { getBgpTable(): BgpRow[] } } } })
    .getRouting().getBgp().getEngine().getBgpTable();

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const PERMIT_16 = ['config router prefix-list', 'edit "only16"', 'config rule', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'set action permit', 'next', 'end', 'next', 'end'];
const MAP_OUT = ['config router route-map', 'edit "tag"', 'config rule', 'edit 1', 'set match-ip-address "only16"', 'set set-metric 77', 'next', 'end', 'next', 'end'];
const MAP_IN = ['config router route-map', 'edit "boost"', 'config rule', 'edit 1', 'set match-ip-address "only1"', 'set set-local-preference 250', 'set set-weight 40', 'next', 'end', 'next', 'end'];
const PERMIT_CISCO_1 = ['config router prefix-list', 'edit "only1"', 'config rule', 'edit 1', 'set prefix 10.1.1.0 255.255.255.0', 'set action permit', 'next', 'end', 'next', 'end'];

async function peering(neighbourLines: readonly string[]) {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const cisco = new CiscoRouter('R1', 200, 0);
  new Cable('transit').connect(firewall.getPort('port2')!, cisco.getPort('GigabitEthernet0/0')!);
  await type(firewall, [...PERMIT_16, ...PERMIT_CISCO_1, ...MAP_OUT, ...MAP_IN,
    'config system interface', 'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next',
    'edit port3', 'set ip 172.17.0.1 255.255.0.0', 'next',
    'edit port2', 'set ip 10.9.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end']);
  await type(cisco, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.9.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 10.1.1.1 255.255.255.0', 'exit',
    'interface Loopback2', 'ip address 10.2.2.1 255.255.255.0', 'exit',
    'router bgp 65002', 'bgp router-id 2.2.2.2', 'neighbor 10.9.0.1 remote-as 65001',
    'network 10.1.1.0 mask 255.255.255.0', 'network 10.2.2.0 mask 255.255.255.0', 'end']);
  await type(firewall, ['config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config network', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'edit 2', 'set prefix 172.17.0.0 255.255.0.0', 'next', 'end',
    'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002', ...neighbourLines, 'next', 'end', 'end']);
  clock.advance(240_000);
  const learned = bgpRows(firewall).map((row) => row.network.toString());
  return { firewall, cisco, learned };
}

describe('router bgp prefix-list-in / prefix-list-out', () => {
  it('TEMOIN : sans filtre le Cisco recoit les deux reseaux', async () => {
    const { cisco } = await peering([]);
    const table = await cisco.executeCommand('show ip bgp');
    expect(table).toContain('172.16.0.0');
    expect(table).toContain('172.17.0.0');
  });

  it('prefix-list-out ne laisse partir que les prefixes permis', async () => {
    const { cisco } = await peering(['set prefix-list-out "only16"']);
    const table = await cisco.executeCommand('show ip bgp');
    expect(table).toContain('172.16.0.0');
    expect(table).not.toContain('172.17.0.0');
  });

  it('prefix-list-in ne retient que les prefixes permis', async () => {
    const { learned } = await peering(['set prefix-list-in "only1"']);
    expect(learned).toContain('10.1.1.0');
    expect(learned).not.toContain('10.2.2.0');
  });

  it('une liste qui n existe pas est refusee', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(firewall, ['config router bgp', 'set as 65001', 'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002']);
    const reply = await firewall.executeCommand('set prefix-list-in "ghost"');
    await type(firewall, ['next', 'end', 'end']);
    expect(reply).toMatch(/entry not found|not found|parse error/i);
  });
});

describe('router route-map sur un voisin', () => {
  it('route-map-out : seul le prefixe permis part (la metrique posee est lue dans la route-map, le Cisco simule n affichant pas la MED recue)', async () => {
    const { cisco, firewall } = await peering(['set route-map-out "tag"']);
    const table = await cisco.executeCommand('show ip bgp');
    expect(table).toContain('172.16.0.0');
    expect(table).not.toContain('172.17.0.0');
    const verdict = (firewall as unknown as { getRouting(): { getRoutePolicies(): { get(name: string): { evaluate(route: { network: string; prefixLength: number }, lists: unknown): { action: string; apply?: { cost?: number } } } } ; getPrefixLists(): unknown } })
      .getRouting().getRoutePolicies().get('tag').evaluate({ network: '172.16.0.0', prefixLength: 16 }, firewall.getRouting().getPrefixLists());
    expect(verdict).toEqual({ action: 'permit', apply: { cost: 77 } });
  });

  it('route-map-in : seul le prefixe permis est retenu, avec LOCAL_PREF et poids poses', async () => {
    const { firewall } = await peering(['set route-map-in "boost"']);
    const rows = bgpRows(firewall).filter((row) => row.network.toString().startsWith('10.'));
    expect(rows.map((row) => row.network.toString())).toEqual(['10.1.1.0']);
    expect(rows[0].localPref).toBe(250);
    expect(rows[0].weight).toBe(40);
  });

  it('une route-map inconnue est refusee', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(firewall, ['config router bgp', 'set as 65001', 'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002']);
    const reply = await firewall.executeCommand('set route-map-in "ghost"');
    await type(firewall, ['next', 'end', 'end']);
    expect(reply).toMatch(/entry not found|not found|parse error/i);
  });
});
