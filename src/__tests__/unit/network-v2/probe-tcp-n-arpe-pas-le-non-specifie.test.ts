/**
 * TCP n'ARPe pas pour 0.0.0.0 — le CINQUIEME site du meme idiome
 * (BRD-Modele-TCP-IP.md phase 8, lot 10).
 *
 * ── D'ou vient ce lot ───────────────────────────────────────────────
 *
 * Une autre session a ferme « On n'envoie pas d'ARP pour 0.0.0.0 » en
 * corrigeant QUATRE sites qui ecrivaient `route.nextHop || destination` :
 * l'idiome dit bien « a defaut de saut suivant, vise la destination »,
 * mais `0.0.0.0` est un OBJET `IPAddress`, donc VRAI — juste pour un
 * `null`, faux pour l'adresse non specifiee. `nextHopTarget` est la regle
 * qu'elle a posee.
 *
 * En relisant ce correctif contre le mien, un CINQUIEME site apparait, et
 * il est sur le chemin que le lot 3 a ouvert : `resolveRouteForHost`,
 * l'accesseur par lequel la pile TCP consulte la table du routeur, ecrit
 * `route.nextHop ?? dest`. Le `??` echappe a la recherche du `||` — meme
 * defaut, autre orthographe.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Un routeur portant `ip route 10.5.0.0 255.255.0.0 GigabitEthernet0/1`
 * — la route par INTERFACE, sans saut suivant — et ouvrant une connexion
 * TCP vers 10.5.0.9 emettait `arpTarget=0.0.0.0`. Personne ne peut
 * repondre a cela : la RFC 1122 §3.2.1.3 fait de 0.0.0.0 « this host on
 * this network », jamais une destination et jamais une cible d'ARP. La
 * connexion ne pouvait donc pas aboutir.
 *
 * Le correctif LIT `nextHopTarget` au lieu d'ecrire un sixieme idiome.
 *
 * ── Le jumeau IPv6 est INATTEIGNABLE, mesure et non suppose ─────────
 *
 * `IPv6DataPlane` porte la meme forme en quatre endroits
 * (`route.nextHop ?? dstIp`, `route.nextHop || ipv6.destinationIP`). Mais
 * `ipv6 route 2001:DB8:5::/64 GigabitEthernet0/1` n'installe RIEN — la
 * forme par interface seule n'est pas gerée cote v6, ce que
 * `show ipv6 route` confirme en ne rendant que la route connectee. Aucun
 * saut suivant non specifie ne peut donc exister dans cette table, et
 * aucune sollicitation de voisin pour `::` n'est observable. C'est
 * inscrit au `TODO.md` plutot que corrige a l'aveugle : corriger une
 * forme qu'aucune commande ne produit serait invente.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur trois tombent. Le TEMOIN — la route avec un VRAI saut
 * suivant — passe des deux cotes et le doit : c'est le cas ordinaire, et
 * c'est parce qu'il marchait que le defaut ne se voyait que sur la forme
 * par interface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

async function maquette(routeStatique: string) {
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('PC');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/1')!, poste.getPorts()[0]);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
    'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    routeStatique, 'end']) {
    await routeur.executeCommand(c);
  }
  await poste.executeCommand('sudo ip addr add 10.0.1.2/24 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');

  const arpVus: string[] = [];
  poste.getPorts()[0].attachTap(({ direction, frame }) => {
    const pkt = frame.payload as { type?: string; targetIP?: { toString(): string } } | undefined;
    if (direction === 'in' && pkt?.type === 'arp') arpVus.push(String(pkt.targetIP));
  });
  return { routeur, arpVus };
}

describe('TCP n\'ARPe pas pour l\'adresse non specifiee', () => {
  it('une route par INTERFACE fait ARPer la DESTINATION', async () => {
    const { routeur, arpVus } = await maquette(
      'ip route 10.5.0.0 255.255.0.0 GigabitEthernet0/1');
    routeur.getTcpStack().connect('10.5.0.9', 80);
    await new Promise((r) => setTimeout(r, 40));
    expect(arpVus).toContain('10.5.0.9');
  });

  it('et elle n\'ARPe JAMAIS 0.0.0.0', async () => {
    const { routeur, arpVus } = await maquette(
      'ip route 10.5.0.0 255.255.0.0 GigabitEthernet0/1');
    routeur.getTcpStack().connect('10.5.0.9', 80);
    await new Promise((r) => setTimeout(r, 40));
    expect(arpVus).not.toContain('0.0.0.0');
  });

  it('TEMOIN : une route avec un VRAI saut suivant ARPe ce saut', async () => {
    const { routeur, arpVus } = await maquette(
      'ip route 10.6.0.0 255.255.0.0 10.0.1.2');
    routeur.getTcpStack().connect('10.6.0.9', 80);
    await new Promise((r) => setTimeout(r, 40));
    expect(arpVus).not.toContain('0.0.0.0');
  });
});
