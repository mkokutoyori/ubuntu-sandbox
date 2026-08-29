/**
 * Une ACL filtre AUSSI les protocoles de routage, et c'est le piege
 * operationnel classique.
 *
 * ── Ce que ce fichier fixe ──────────────────────────────────────────
 *
 * OSPF n'est pas « du controle » a part : c'est le protocole IP numero
 * 89, et il traverse la liste comme le reste. Un `deny ip any any` pose
 * en entree d'une interface fait donc TOMBER l'adjacence — l'operateur
 * croit avoir filtre « les utilisateurs » et il a coupe son routage. La
 * ligne qui repare est `permit ospf any any` AVANT le deny.
 *
 * Les trois etats sont mesures sur la meme maquette : sans liste,
 * l'adjacence est FULL ; avec `deny ip any any`, il n'y a plus de voisin
 * du tout ; avec `permit ospf` en tete, elle revient. Le premier et le
 * troisieme sont les TEMOINS du second — sans eux, une maquette ou
 * l'adjacence ne se formerait jamais donnerait le meme « pas de voisin »
 * et on croirait avoir demontre quelque chose.
 *
 * ── Ce qui n'est PAS teste ici, et pourquoi ─────────────────────────
 *
 * L'ACL est posee en `in` sur l'interface qui porte l'adjacence, parce
 * que c'est la que le paquet OSPF du voisin arrive. En `out` elle ne
 * verrait pas les Hello RECUS ; c'est un autre cas, et le melanger a
 * celui-ci ferait croire que la direction n'importe pas.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * `ACLEngine.evaluateForDataPlane` neutralise (rendant `permit` sans
 * lire la liste) fait tomber 2 des 4 cas. Les 2 autres sont nommes
 * plutot que laisses a decouvrir : le TEMOIN sans liste et le cas
 * `permit ospf`, dont le verdict attendu EST « le trafic passe » — c'est
 * leur objet de passer des deux cotes, et sans eux les deux premiers ne
 * prouveraient pas que la maquette sait former une adjacence.
 *
 * Note pour qui refera la mesure : le plan de donnees appelle
 * `evaluateForDataPlane` et non `evaluateACL`. Neutraliser la seconde
 * laisse ces cas verts et ne demontre rien.
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

async function deuxRouteursOspf(acl: readonly string[]) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
    ...acl, 'end']) {
    await r1.executeCommand(c);
  }
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit', 'end']) {
    await r2.executeCommand(c);
  }
  await new Promise((r) => setTimeout(r, 60));
  return { r1, r2 };
}

const POSE_EN_ENTREE = [
  'interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit',
] as const;

describe('une ACL filtre aussi le routage', () => {
  it('TEMOIN : sans liste, l\'adjacence est FULL', async () => {
    const { r1 } = await deuxRouteursOspf([]);
    expect(await r1.executeCommand('show ip ospf neighbor')).toContain('FULL');
  });

  it('`deny ip any any` fait TOMBER l\'adjacence — OSPF est du trafic IP', async () => {
    const { r1 } = await deuxRouteursOspf([
      'access-list 100 deny ip any any', ...POSE_EN_ENTREE,
    ]);
    const voisins = await r1.executeCommand('show ip ospf neighbor');
    expect(voisins).not.toContain('FULL');
    expect(voisins).not.toContain('10.0.0.2');
  });

  it('`permit ospf any any` place AVANT le deny la retablit', async () => {
    const { r1 } = await deuxRouteursOspf([
      'access-list 100 permit ospf any any',
      'access-list 100 deny ip any any',
      ...POSE_EN_ENTREE,
    ]);
    expect(await r1.executeCommand('show ip ospf neighbor')).toContain('FULL');
  });

  it('permettre le seul ICMP ne suffit PAS a sauver l\'adjacence', async () => {
    const { r1 } = await deuxRouteursOspf([
      'access-list 100 permit icmp any any',
      'access-list 100 deny ip any any',
      ...POSE_EN_ENTREE,
    ]);
    expect(await r1.executeCommand('show ip ospf neighbor')).not.toContain('FULL');
  });
});
