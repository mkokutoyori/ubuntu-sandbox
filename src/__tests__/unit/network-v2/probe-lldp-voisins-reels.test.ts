/**
 * `show lldp neighbors` ne liste que ce qui a EMIS une trame LLDP.
 *
 * Mesure de depart : `lldpNeighbours()` fusionnait les voisins APPRIS
 * avec `EquipmentStateView(dev).neighbors()`, c'est-a-dire le plan de
 * CABLAGE. Un commutateur sans `lldp run` et un serveur Linux sans
 * `lldpd` etaient donc listes tous les deux avec `Hold-time 120` alors
 * que l'agent en avait appris ZERO, et ils SURVIVAIENT a
 * `no lldp receive` -- l'inverse exact de la lecon que cette commande
 * existe pour enseigner (« pas de voisin LLDP => le cable est debranche,
 * ou LLDP n'est pas active »). CDP faisait deja la bonne chose sur la
 * meme machine : deux vues de la meme question, deux reponses.
 *
 * Discrimine par `git stash` : 9 cas tombent avant correctif. J'en
 * avais annonce 8, et la mesure a corrige la prevision -- « un voisin
 * qui parle LLDP est bien la » tombe lui aussi, parce que la fusion
 * comptait DEUX entrees la ou il n'y en a qu'une ; ce cas reste dans la
 * sonde parce que sans lui, un correctif qui n'afficherait plus RIEN la
 * passerait.
 *
 * Les 3 qui passent des deux cotes, nommes plutot que laisses a
 * decouvrir :
 *  - « le TEMOIN CDP » : dont c'est justement l'objet de passer avant
 *    comme apres, puisque CDP etait deja juste et sert de reference.
 *  - « lldp run absent » : la vue vide existait deja.
 *  - « la legende des capacites » : le texte de l'en-tete n'a pas change.
 *
 * References mesurees : capture reelle `ntc-templates`
 * `tests/cisco_ios/show_lldp_neighbors/cisco_ios_show_lldp_neighbors.raw`
 * (colonne Capability en LETTRES `B` / `B,R` / `T`, `Local Intf` en forme
 * courte SANS espace `Fa0/13`), et
 * `show_lldp_neighbors_detail/..._detail1.raw` (formes
 * `System Name - not advertised`, `Chassis id: 7c25.86c9.aaaa`).
 * Le texte IEEE 802.1AB lui-meme n'est pas atteignable depuis ce reseau
 * (403 sur standards.ieee.org, ieee802.org et mentor.ieee.org) : les
 * constantes viennent de `lldpd/src/lldp-const.h` (bits de capacite
 * OTHER 0x01, REPEATER 0x02, BRIDGE 0x04, ROUTER 0x10, TELEPHONE 0x20,
 * STATION 0x80 -- d'ou l'ordre `B,R`) et du dissecteur Wireshark
 * `packet-lldp.c` (types de TLV 0 a 8 et 127).
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

async function conf(d: { executeCommand(c: string): Promise<string> }, ...cmds: string[]) {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  for (const c of cmds) await d.executeCommand(c);
  await d.executeCommand('end');
}

function labo() {
  const a = new CiscoSwitch('switch-cisco', 'SW-A', 12);
  const muet = new CiscoSwitch('switch-cisco', 'SW-MUET', 12);
  const srv = new LinuxPC('linux-pc', 'SRV', 0, 0);
  new Cable('c1').connect(a.getPort('FastEthernet0/1')!, muet.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(a.getPort('FastEthernet0/10')!, srv.getPort('eth0')!);
  return { a, muet, srv };
}

describe('show lldp neighbors ne liste que les vrais voisins LLDP', () => {
  it('un voisin cable qui ne parle PAS LLDP n est pas liste', async () => {
    const { a } = labo();
    await conf(a, 'lldp run');
    const out = await a.executeCommand('show lldp neighbors');
    expect(a.getLldpAgent().getNeighbors()).toHaveLength(0);
    expect(out).not.toContain('SW-MUET');
    expect(out).toContain('Total entries displayed: 0');
  });

  it('un hote Linux sans lldpd n est pas liste', async () => {
    const { a } = labo();
    await conf(a, 'lldp run');
    expect(await a.executeCommand('show lldp neighbors')).not.toContain('SRV');
  });

  it('un voisin qui parle LLDP est bien la', async () => {
    const { a, muet } = labo();
    await conf(a, 'lldp run');
    await conf(muet, 'lldp run');
    const out = await a.executeCommand('show lldp neighbors');
    expect(out).toContain('SW-MUET');
    expect(out).toContain('Total entries displayed: 1');
  });

  it('no lldp receive fait DISPARAITRE le voisin de la vue', async () => {
    const { a, muet } = labo();
    await conf(a, 'lldp run');
    await conf(muet, 'lldp run');
    expect(await a.executeCommand('show lldp neighbors')).toContain('SW-MUET');
    await conf(a, 'interface FastEthernet0/1', 'no lldp receive');
    const out = await a.executeCommand('show lldp neighbors');
    expect(out).not.toContain('SW-MUET');
    expect(out).toContain('Total entries displayed: 0');
  });

  it('la capacite est rendue en LETTRES, pas en mots', async () => {
    const { a, muet } = labo();
    await conf(a, 'lldp run');
    await conf(muet, 'lldp run');
    const ligne = (await a.executeCommand('show lldp neighbors'))
      .split('\n').find(l => l.startsWith('SW-MUET'))!;
    expect(ligne).toMatch(/\bB\b/);
    expect(ligne).not.toContain('Switch');
  });

  it('un routeur annonce R la ou un commutateur annonce B', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    await conf(r1, 'lldp run');
    await conf(r2, 'lldp run');
    const ligne = (await r1.executeCommand('show lldp neighbors'))
      .split('\n').find(l => l.startsWith('R2'))!;
    expect(ligne).toMatch(/\bR\b/);
    expect(ligne).not.toContain('Router  ');
  });

  it('Local Intf est la forme courte SANS espace (Fa0/1, pas Fas 0/1)', async () => {
    const { a, muet } = labo();
    await conf(a, 'lldp run');
    await conf(muet, 'lldp run');
    const out = await a.executeCommand('show lldp neighbors');
    expect(out).toContain('Fa0/1');
    expect(out).not.toContain('Fas 0/1');
  });

  it('le TEMOIN CDP : il ne listait deja que les vrais voisins', async () => {
    const { a, muet } = labo();
    await conf(a, 'cdp run');
    await conf(muet, 'cdp run');
    const out = await a.executeCommand('show cdp neighbors');
    expect(out).toContain('SW-MUET');
    expect(out).not.toContain('SRV');
  });

  it('lldp run absent : la vue est vide et le dit', async () => {
    const { a } = labo();
    await a.executeCommand('enable');
    const out = await a.executeCommand('show lldp neighbors');
    expect(out).toContain('Total entries displayed: 0');
  });

  it('la legende des capacites est celle de la capture reelle', async () => {
    const { a } = labo();
    await conf(a, 'lldp run');
    const out = await a.executeCommand('show lldp neighbors');
    expect(out).toContain('(R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device');
    expect(out).toContain('(W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other');
  });

  it('le detail ne decrit que les voisins appris', async () => {
    const { a } = labo();
    await conf(a, 'lldp run');
    expect(await a.executeCommand('show lldp neighbors detail'))
      .toBe('Total entries displayed: 0');
  });

  it('le detail porte les formes « - not advertised » de la capture', async () => {
    const { a, muet } = labo();
    await conf(a, 'lldp run');
    await conf(muet, 'lldp run');
    const out = await a.executeCommand('show lldp neighbors detail');
    expect(out).toContain('Management Addresses - not advertised');
    expect(out).toContain('System Capabilities: B');
    expect(out).toMatch(/Chassis id: [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);
  });
});
