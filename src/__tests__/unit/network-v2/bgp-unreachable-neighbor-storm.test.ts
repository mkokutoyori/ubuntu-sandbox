/**
 * Régression — un voisin BGP configuré mais injoignable ne doit pas
 * emballer le routeur.
 *
 * Le scénario d'origine : coller ~400 lignes de configuration routage
 * dans le terminal d'un routeur Cisco figeait l'onglet du navigateur.
 * La cause n'était pas le collage, mais la boucle qu'il amorçait —
 * `router bgp` + `neighbor` sur des interfaces sans câble :
 *
 *   converge → manageSessions() compose le voisin → le SYN part →
 *   l'ARP reste sans réponse → au bout de 2 s le routeur fabrique un
 *   ICMP unreachable pour son propre SYN → router cet ICMP appelle
 *   `lookupRoute()` → qui appelle `refresh()` → qui appelait
 *   `bgp.converge()` → qui recompose chaque voisin…
 *
 * Une composition par voisin et par niveau, doublant à chaque expiration
 * ARP. Chaque tentative laissait de plus un socket bloqué en `syn-sent`
 * (`close()` y était différé indéfiniment), donc le pool de ports
 * éphémères se vidait, et chaque tentative suivante déversait un
 * `%TCP-4-WARNINGS: Segment dropped (no-ephemeral)` dans le terminal —
 * des centaines de milliers de lignes en quelques secondes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  __assumeCarrierOnUncabledPorts,
} from '@/network/devices/inspection/InterfaceStatusView';

const CONFIG = [
  'enable',
  'configure terminal',
  'hostname R-ROUTE',
  'interface GigabitEthernet0/0',
  'ip address 10.0.12.1 255.255.255.0',
  'no shutdown',
  'exit',
  'interface GigabitEthernet0/1',
  'ip address 10.0.13.1 255.255.255.0',
  'no shutdown',
  'end',
  'configure terminal',
  'router bgp 65001',
  'bgp router-id 1.1.1.1',
  'neighbor 10.0.12.2 remote-as 65002',
  'neighbor 10.0.13.2 remote-as 65001',
  'end',
];

interface StackPeek { sockets: Map<unknown, unknown> }

function socketCount(r: CiscoRouter): number {
  return (r as unknown as { getTcpStack(): StackPeek }).getTcpStack().sockets.size;
}

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  // Les ports portent une adresse et sont `no shutdown` mais ne sont
  // câblés à rien : c'est exactement la topologie de l'utilisateur, un
  // routeur seul sur le canvas.
  __assumeCarrierOnUncabledPorts(true);
});

describe('BGP — voisin configuré et injoignable', () => {
  it("ne draine pas le pool de ports éphémères, même après plusieurs secondes", async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 100, 100);
    r.powerOn?.();

    const drops = new Map<string, number>();
    const off = r.getBus().subscribe('tcp.segment.dropped', (e) => {
      const reason = (e.payload as { reason: string }).reason;
      drops.set(reason, (drops.get(reason) ?? 0) + 1);
    });

    for (const c of CONFIG) await r.executeCommand(c);
    await r.executeCommand('show ip bgp summary');

    // Deux expirations ARP complètes (2 s chacune) : c'est la cadence à
    // laquelle la cascade doublait.
    await new Promise((res) => setTimeout(res, 5_000));
    off();

    expect(drops.get('no-ephemeral') ?? 0).toBe(0);
    // Une poignée de tentatives est normale ; une cascade se compte en
    // milliers.
    expect(socketCount(r)).toBeLessThan(20);
  }, 30_000);

  it("le trafic EIGRP ne compose aucune session BGP", async () => {
    // R1 parle EIGRP à un voisin réellement câblé, et porte en plus un
    // voisin BGP injoignable. Le va-et-vient EIGRP met à jour la RIB
    // d'EIGRP ; il n'a aucune raison de faire rejouer la décision de
    // meilleur chemin BGP, encore moins de composer le voisin absent.
    const r1 = new CiscoRouter('router-cisco', 'R1', 100, 100);
    const r2 = new CiscoRouter('router-cisco', 'R2', 300, 100);
    r1.powerOn?.(); r2.powerOn?.();
    for (const c of CONFIG) await r1.executeCommand(c);
    for (const c of CONFIG.filter((x) => !x.startsWith('neighbor')
      && !x.startsWith('router bgp') && !x.startsWith('bgp router-id'))) {
      await r2.executeCommand(c === 'ip address 10.0.12.1 255.255.255.0'
        ? 'ip address 10.0.12.2 255.255.255.0' : c);
    }
    new Cable('lan').connect(
      r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    for (const r of [r1, r2]) {
      await r.executeCommand('configure terminal');
      await r.executeCommand('router eigrp 100');
      await r.executeCommand('network 10.0.12.0 0.0.0.255');
      await r.executeCommand('end');
    }

    const before = socketCount(r1);
    // Du trafic EIGRP réel traverse le câble dans les deux sens.
    for (let i = 0; i < 20; i++) await r2.executeCommand('show ip eigrp neighbors');
    expect(socketCount(r1)).toBe(before);
  }, 60_000);

  it('reste joignable en ligne de commande après la tempête évitée', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 100, 100);
    r.powerOn?.();
    for (const c of CONFIG) await r.executeCommand(c);
    await new Promise((res) => setTimeout(res, 3_000));

    const summary = await r.executeCommand('show ip bgp summary');
    expect(summary).toContain('10.0.12.2');
    expect(summary).toContain('10.0.13.2');
    // Les voisins injoignables restent Idle/Active — jamais Established.
    expect(summary).not.toMatch(/Established/i);
  }, 30_000);
});

describe('TCP — close() sur un socket resté en syn-sent', () => {
  it('supprime la TCB au lieu de garder le port éphémère (RFC 9293 §3.10.4)', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 100, 100);
    r.powerOn?.();
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.12.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    const stack = (r as unknown as {
      getTcpStack(): StackPeek & {
        connect(ip: string, port: number): { state: string; close(): void } | null;
      };
    }).getTcpStack();

    const before = stack.sockets.size;
    for (let i = 0; i < 50; i++) {
      // Personne au bout du câble : la poignée de main ne se termine pas.
      const s = stack.connect('10.0.12.2', 179);
      expect(s?.state).not.toBe('established');
      s?.close();
    }
    expect(stack.sockets.size).toBe(before);
  }, 30_000);
});
