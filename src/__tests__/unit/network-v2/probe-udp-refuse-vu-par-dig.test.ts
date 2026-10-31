/**
 * RFC 1122 §4.1.3.1 : un datagramme UDP vers un port fermé provoque un ICMP « port unreachable » que le noyau reporte à la prise
 * connectée (ECONNREFUSED). BIND 9.18 (bin/dig/dighost.c, recv_done/udp_ready) l'écrit `;; communications error to ADDR#PORT:
 * connection refused` à chaque essai (+tries, 3 par défaut) puis `;; no servers could be reached` ; le banner de dig reprend les
 * arguments TELS QUE TAPÉS (bin/dig/dig.c, `lookup->cmdline`).
 *
 * Mesure de départ : `dig -p 9999 @10.0.0.2 example.com` répondait `;; connection timed out; no servers could be reached`, trois fois
 * plus lentement qu'un refus réel, et le banner perdait `-p 9999`. 3 des 4 cas tombent avant le correctif ; le témoin (un pare-feu qui
 * jette le datagramme) donne bien le silence et passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('dig contre un port UDP fermé', () => {
  it('trois essais refusés, puis plus aucun serveur', async () => {
    const lab = labo();
    const out = await lab.front.executeCommand('dig -p 9999 @10.0.0.2 example.com');
    expect(out.split('\n').filter((l) => l === ';; communications error to 10.0.0.2#9999: connection refused')).toHaveLength(3);
    expect(out).toContain(';; no servers could be reached');
    expect(out).not.toContain('connection timed out');
  });

  it('+tries=1 ne refuse qu\'une fois', async () => {
    const lab = labo();
    const out = await lab.front.executeCommand('dig -p 9999 @10.0.0.2 example.com +tries=1');
    expect(out.split('\n').filter((l) => l.includes('connection refused'))).toHaveLength(1);
  });

  it('le banner reprend les arguments tels que tapés', async () => {
    const lab = labo();
    const out = await lab.front.executeCommand('dig -p 9999 @10.0.0.2 example.com +tries=1');
    expect(out).toContain('; <<>> DiG <<>> -p 9999 @10.0.0.2 example.com +tries=1');
  });

  it('témoin : un datagramme jeté par le pare-feu donne le silence, pas un refus', async () => {
    const lab = labo();
    await lab.back.executeCommand('iptables -A INPUT -p udp --dport 9999 -j DROP');
    const out = await lab.front.executeCommand('dig -p 9999 @10.0.0.2 example.com +tries=1 +time=1');
    expect(out).toContain('connection timed out; no servers could be reached');
    expect(out).not.toContain('connection refused');
  }, 20_000);
});
