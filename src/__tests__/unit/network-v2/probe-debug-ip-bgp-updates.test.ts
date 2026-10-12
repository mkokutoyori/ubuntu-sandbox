/*
 * `debug ip bgp updates` : les UPDATE que deux routeurs echangent.
 *
 * Avant le correctif la commande etait refusee (`% Invalid input detected`)
 * et le moteur BGP ne publiait que les changements d'etat de voisin : les
 * UPDATE passaient par BgpSession sans laisser de trace sur le bus. Le
 * moteur publie maintenant `bgp.update.sent` / `bgp.update.received` a
 * l'endroit meme ou le message est emis et traite (annonce, retrait,
 * attributs), et le service de debug les rend en `BGP(0): <pair> send|rcvd
 * UPDATE ...`. Le mot-cle est distinct de `debug ip bgp`, qui continue de
 * ne rendre que les transitions d'etat.
 *
 * Le texte des lignes est derive des attributs reels du message ; sa
 * forme exacte sur un IOS n'est pas attestee depuis ce reseau.
 *
 * Defaut decouvert en ecrivant le cas du retrait : `no network` sous
 * `router bgp` ne retirait le prefixe que du modele de configuration, pas
 * de la configuration du moteur, et ne declenchait aucune convergence : le
 * prefixe restait annonce et le pair le gardait dans sa table. Le retrait
 * atteint maintenant le moteur, qui envoie un UPDATE de retrait.
 *
 * Avant le correctif : 3 des 5 cas tombent (git stash de src/network).
 * Passent des deux cotes le TEMOIN « debug ip bgp seul ne trace pas les
 * UPDATE » (le laboratoire echange bien des UPDATE, verifie par la table
 * BGP du pair : le silence vient du mot-cle) et « no debug ip bgp updates
 * arrete la trace », vide avant le correctif puisque la commande etait
 * refusee : il ne vaut que contre le cas positif du meme laboratoire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function run(d: CiscoRouter, ...lines: string[]): Promise<string> {
  let last = '';
  for (const l of lines) last = await d.executeCommand(l);
  return last;
}

async function lab(debugCommand: string) {
  const p = new CiscoRouter('BA1');
  const q = new CiscoRouter('BB1');
  new Cable('bc1').connect(p.getPorts()[0], q.getPorts()[0]);
  for (const [d, ip] of [[p, '10.0.9.1'], [q, '10.0.9.2']] as const) {
    await run(d, 'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end');
  }
  await run(q, 'configure terminal', 'interface Loopback0', 'ip address 192.0.2.1 255.255.255.255', 'exit',
    'router bgp 65002', 'neighbor 10.0.9.1 remote-as 65001', 'network 192.0.2.1 mask 255.255.255.255', 'end');
  await run(p, debugCommand);
  const lines: string[] = [];
  collecteDebug((p as unknown as { getDebugService(): { subscribe(f: (l: string) => void): () => void } }).getDebugService(), lines);
  await run(p, 'configure terminal', 'router bgp 65001', 'neighbor 10.0.9.2 remote-as 65002', 'end');
  return { p, q, lines };
}

describe('debug ip bgp updates', () => {
  it('WITNESS : debug ip bgp seul ne trace pas les UPDATE, et le pair a bien appris la route', async () => {
    const { p, lines } = await lab('debug ip bgp');
    expect(await run(p, 'show ip bgp')).toContain('192.0.2.1');
    expect(lines.some((l) => l.includes('UPDATE'))).toBe(false);
  });

  it('la commande est acceptee et listee', async () => {
    const p = new CiscoRouter('BA2');
    await run(p, 'enable');
    expect(await run(p, 'debug ip bgp updates')).toBe('BGP updates debugging is on');
    expect(await run(p, 'show debugging')).toContain('BGP updates debugging is on');
    expect(await run(p, 'no debug ip bgp updates')).toBe('BGP updates debugging is off');
  });

  it('un UPDATE recu est trace avec ses attributs et son prefixe', async () => {
    const { lines } = await lab('debug ip bgp updates');
    const out = lines.join('\n');
    expect(out).toMatch(/BGP\(0\): 10\.0\.9\.2 rcvd UPDATE w\/ attr: .*path 65002.*next hop 10\.0\.9\.2/);
    expect(out).toContain('BGP(0): 10.0.9.2 rcvd UPDATE 192.0.2.1/32');
  });

  it('un retrait est trace', async () => {
    const { p, q, lines } = await lab('debug ip bgp updates');
    await run(q, 'configure terminal', 'router bgp 65002', 'no network 192.0.2.1 mask 255.255.255.255', 'end');
    expect(await run(p, 'show ip bgp')).not.toContain('192.0.2.1/32');
    expect(lines.join('\n')).toContain('BGP(0): 10.0.9.2 rcvd UPDATE 192.0.2.1/32 -- withdrawn');
  });

  it('no debug ip bgp updates arrete la trace', async () => {
    const { p, q, lines } = await lab('debug ip bgp updates');
    await run(p, 'no debug ip bgp updates');
    const before = lines.length;
    await run(q, 'configure terminal', 'router bgp 65002', 'no network 192.0.2.1 mask 255.255.255.255', 'end');
    expect(lines.length).toBe(before);
  });
});
