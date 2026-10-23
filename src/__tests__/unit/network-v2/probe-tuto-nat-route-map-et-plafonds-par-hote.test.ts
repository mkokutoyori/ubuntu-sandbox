/**
 * Tuto NAT / PAT sur Cisco, parties 11.2 et 12.3 : `ip nat inside source route-map` et
 * `ip nat translation max-entries host <ip> <n>`.
 *
 * Mesure avant correction : la forme route-map etait acceptee, rangee dans un champ prive du
 * routeur que rien ne lisait (absente de `show running-config | section ip nat`, aucune
 * traduction), et `max-entries host` repondait « % Invalid max-entries value. ». Le plafond total
 * n'etait par ailleurs applique qu'aux regles « overload », pas aux regles « pool », et n'etait
 * pas rendu dans la configuration. Le route-map est desormais evalue (clauses dans l'ordre des
 * numeros, un refus arrete la recherche, `match ip address` et `match interface` decident ; tout
 * autre critere ne peut pas etre decide ici et ne correspond donc pas, ce qui est le sens sur
 * pour une regle de securite), le plafond par hote et `all-host` sont appliques par la meme
 * fonction que le plafond total, sur les deux sortes de regles, et tout est rendu.
 *
 * Defaut trouve par le cas du refus : `route-map X deny 10` suivi de n'importe quelle ligne `match`
 * redevenait une clause `permit`, parce que la saisie de la ligne rappelait `ensureRouteMap` avec
 * l'action `permit`. Une clause de refus n'a jamais pu refuser. Corrige en cherchant la clause au
 * lieu de la recreer.
 *
 * Avec src remis a HEAD, 6 cas sur 9 tombent. Trois passent dans les deux etats : le temoin du
 * laboratoire (le PAT par liste traduit les deux postes) et les deux cas qui n'attendent AUCUNE
 * traduction (interface de sortie differente, critere indecidable), que l'absence d'implementation
 * donne aussi ; leur valeur est de borner le cas qui traduit, pas de se discriminer eux-memes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab, runLines } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const LIST_PAT = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';
const MAP_PAT = 'ip nat inside source route-map RM-ISP1 interface GigabitEthernet0/1 overload';
const ping = (host: { executeCommand(c: string): Promise<string> }) => host.executeCommand('ping 198.51.100.10');
const pingTo = (host: { executeCommand(c: string): Promise<string> }, ip: string) => host.executeCommand(`ping ${ip}`);
const received = (out: string) => Number(/Received = (\d+)/.exec(out)?.[1] ?? '0');

describe('ip nat inside source route-map', () => {
  it('witness: the list-based PAT translates both inside hosts', async () => {
    const { win, lin } = await tutoNatLab([LIST_PAT]);
    expect(received(await ping(win))).toBe(4);
    expect(await lin.executeCommand('ping -c 2 198.51.100.10')).toContain('2 received');
  });

  it('translates only what its permit clause selects: access list and egress interface', async () => {
    const { r, win, lin } = await tutoNatLab([
      'access-list 2 permit host 192.168.10.22',
      'route-map RM-ISP1 permit 10', 'match ip address 2', 'match interface GigabitEthernet0/1', 'exit',
      MAP_PAT,
    ]);
    expect(await lin.executeCommand('ping -c 2 198.51.100.10')).toContain('2 received');
    expect(received(await ping(win))).toBe(0);
    expect(await r.executeCommand('show ip nat translations')).toMatch(/192\.168\.10\.22/);
  });

  it('translates nothing when the egress interface it names is not the one used', async () => {
    const { lin } = await tutoNatLab([
      'route-map RM-ISP1 permit 10', 'match ip address 1', 'match interface GigabitEthernet0/0', 'exit', MAP_PAT,
    ]);
    expect(await lin.executeCommand('ping -c 2 198.51.100.10')).toContain('0 received');
  });

  it('stops at a deny clause and goes on with the next permit clause', async () => {
    const { win, lin } = await tutoNatLab([
      'access-list 2 permit host 192.168.10.22',
      'route-map RM-ISP1 deny 10', 'match ip address 2', 'exit',
      'route-map RM-ISP1 permit 20', 'match ip address 1', 'exit',
      MAP_PAT,
    ]);
    expect(await lin.executeCommand('ping -c 2 198.51.100.10')).toContain('0 received');
    expect(received(await ping(win))).toBe(4);
  });

  it('fails closed on a criterion it cannot decide', async () => {
    const { lin } = await tutoNatLab([
      'route-map RM-ISP1 permit 10', 'match ip next-hop 1', 'exit', MAP_PAT,
    ]);
    expect(await lin.executeCommand('ping -c 2 198.51.100.10')).toContain('0 received');
  });

  it('is rendered in the running-config and removed by its no form', async () => {
    const { r } = await tutoNatLab([MAP_PAT]);
    expect(await r.executeCommand('show running-config | section ip nat')).toContain(MAP_PAT);
    await runLines(r, ['configure terminal', 'no ip nat inside source route-map RM-ISP1', 'end']);
    expect(await r.executeCommand('show running-config | section ip nat')).not.toContain('route-map');
  });
});

describe('ip nat translation max-entries host / all-host', () => {
  it('caps the translations of one host and leaves the others alone', async () => {
    const { win, lin } = await tutoNatLab([LIST_PAT, 'ip nat translation max-entries host 192.168.10.21 1']);
    expect(received(await ping(win))).toBe(4);
    expect(received(await pingTo(win, '203.0.113.9'))).toBe(0);
    expect(await lin.executeCommand('ping -c 3 198.51.100.10')).toContain('3 received');
  });

  it('all-host caps every host, and the cap also binds a pool rule', async () => {
    const { win } = await tutoNatLab([
      'ip nat pool POOL-AKWA 203.0.113.4 203.0.113.6 netmask 255.255.255.240',
      'ip nat inside source list 1 pool POOL-AKWA overload',
      'ip nat translation max-entries all-host 2',
    ]);
    expect(received(await ping(win))).toBe(4);
    expect(received(await pingTo(win, '203.0.113.9'))).toBe(4);
    expect(received(await pingTo(win, '203.0.113.1'))).toBe(0);
  });

  it('is rendered in the running-config, in the three forms', async () => {
    const { r } = await tutoNatLab([
      LIST_PAT, 'ip nat translation max-entries 10000', 'ip nat translation max-entries all-host 500',
      'ip nat translation max-entries host 192.168.10.21 100',
    ]);
    const config = await r.executeCommand('show running-config | section ip nat');
    expect(config).toContain('ip nat translation max-entries 10000');
    expect(config).toContain('ip nat translation max-entries all-host 500');
    expect(config).toContain('ip nat translation max-entries host 192.168.10.21 100');
  });
});
