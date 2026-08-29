/**
 * Une liste SORTANTE filtre le TRANSIT, jamais ce que le routeur
 * produit lui-meme.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────
 *
 * Il est le pendant exact de `probe-liste-entrante-ne-juge-que-l-
 * entrant` : celui-la a corrige une liste ENTRANTE qui jugeait des
 * paquets n'entrant pas, celui-ci fixe la regle symetrique dans l'autre
 * direction. Et il faut le dire d'emblee, sans quoi ce fichier se
 * lirait comme un correctif qu'il n'est pas : **la mesure n'a trouve
 * AUCUN defaut ici**. Les quatre comportements etaient deja justes. Ce
 * qui manquait etait un test, et l'absence de test est ce qui rend une
 * regle facile a casser sans s'en apercevoir — un jour ou l'autre,
 * quelqu'un fera passer l'emission du plan de controle par
 * `forwardPacket` « pour uniformiser », et ces cas sont ce qui l'en
 * avertira.
 *
 * ── La regle, et son autorite ───────────────────────────────────────
 *
 * Sur un IOS reel, TOUT le trafic genere par le routeur lui-meme est
 * exempte du traitement des listes de controle. Une liste posee en
 * sortie est donc tres efficace contre le trafic de TRANSIT — celui qui
 * est arrive de quelque part et que le routeur fait suivre — et sans
 * effet sur ce que le routeur emet : ses pings, ses hellos OSPF, ses
 * hellos HSRP, ses mises a jour de routage. Cisco le documente comme un
 * choix de frontiere de confiance, et donne la `distribute-list` comme
 * moyen de gouverner le trafic de routage qu'un routeur produit.
 *
 * La consequence pratique est celle qu'un apprenant doit connaitre :
 * pour filtrer ce qu'un routeur emet, il faut poser la liste EN ENTREE
 * sur la machine d'en face. C'est aussi ce qui rend le correctif de la
 * liste entrante important — c'est le seul des deux cotes qui peut
 * gouverner ce trafic.
 *
 * ── Ce que chaque cas OBSERVE, et un piege evite ────────────────────
 *
 * L'observable doit prouver que le paquet du routeur est SORTI, ce qui
 * n'est pas la meme chose que « le routeur a l'air en bonne sante ».
 * Une premiere version regardait `show standby` sur R1 et concluait de
 * `Standby router is 10.0.12.2` que ses propres hellos etaient partis —
 * c'est faux : cette ligne dit seulement que R1 a RECU ceux de R2, ce
 * qu'une liste SORTANTE ne peut de toute facon pas empecher. Le cas
 * interroge donc R2, et OSPF est juge sur l'etat FULL, qui exige des
 * hellos dans les DEUX sens.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Aucune : ces quatre comportements sont justes avant comme apres, il
 * n'y a pas d'etat « avant » a restaurer. Annoncer un nombre de cas
 * tombants serait mentir. Ce fichier est un GARDE-FOU, et son cas de
 * TRANSIT est ce qui l'empeche d'etre vide de sens : sans lui, une
 * implantation qui ne filtrerait RIEN en sortie passerait les trois
 * autres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const DENY_SORTANT = ['access-list 100 deny ip any any'];

/** Deux routeurs face a face, la liste posee EN SORTIE sur R1 seulement. */
async function paire(aclSortante: readonly string[], surInterface: readonly string[]) {
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);

  for (const [routeur, n] of [[r1, '1'], [r2, '2']] as const) {
    for (const commande of ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address 10.0.12.${n} 255.255.255.0`,
      'no shutdown', ...surInterface, 'exit',
      ...(routeur === r1 ? aclSortante : []),
      ...(routeur === r1 && aclSortante.length
        ? ['interface GigabitEthernet0/0', 'ip access-group 100 out', 'exit'] : []),
      'end']) {
      await routeur.executeCommand(commande);
    }
  }
  horloge.advance(120000);
  return { r1, r2 };
}

describe('ce que le routeur EMET traverse sa propre liste sortante', () => {
  it('son `ping` aboutit malgre `deny ip any any` en sortie', async () => {
    const { r1 } = await paire(DENY_SORTANT, []);
    expect(await r1.executeCommand('ping 10.0.12.2')).toContain('!!!!!');
  });

  it('et la liste ne compte AUCUNE correspondance', async () => {
    const { r1 } = await paire(DENY_SORTANT, []);
    await r1.executeCommand('ping 10.0.12.2');
    expect(await r1.executeCommand('show access-lists 100')).not.toMatch(/\(\d+ match/);
  });

  it('son adjacence OSPF atteint FULL — donc ses hellos sont bien SORTIS', async () => {
    const { r1 } = await paire(DENY_SORTANT, ['ip ospf 1 area 0']);
    for (const commande of ['configure terminal', 'router ospf 1',
      'network 10.0.12.0 0.0.0.255 area 0', 'end']) {
      await r1.executeCommand(commande);
    }
    expect(await r1.executeCommand('show ip ospf neighbor')).toContain('FULL');
  });

  it('et R2 voit R1 en HSRP — observe chez le PAIR, pas chez l\'emetteur', async () => {
    const { r2 } = await paire(DENY_SORTANT, ['standby 1 ip 10.0.12.254']);
    expect(await r2.executeCommand('show standby')).toContain('10.0.12.1');
  });
});

describe('le TRANSIT, lui, est bien filtre', () => {
  async function traverse(acl: readonly string[]): Promise<string> {
    const horloge = new VirtualTimeScheduler();
    __setDefaultScheduler(horloge);
    const routeur = new CiscoRouter('R');
    const a = new LinuxPC('A');
    const b = new LinuxPC('B');
    new Cable('l1').connect(routeur.getPort('GigabitEthernet0/0')!, a.getPorts()[0]);
    new Cable('l2').connect(routeur.getPort('GigabitEthernet0/1')!, b.getPorts()[0]);
    for (const commande of ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
      ...acl,
      ...(acl.length
        ? ['interface GigabitEthernet0/1', 'ip access-group 100 out', 'exit'] : []),
      'end']) {
      await routeur.executeCommand(commande);
    }
    for (const [poste, n] of [[a, '1'], [b, '2']] as const) {
      await poste.executeCommand(`sudo ip addr add 10.0.${n}.10/24 dev eth0`);
      await poste.executeCommand('sudo ip link set eth0 up');
      await poste.executeCommand(`sudo ip route add default via 10.0.${n}.1`);
    }
    return a.executeCommand('ping -c 1 10.0.2.10');
  }

  it('TEMOIN : sans liste, le paquet traverse', async () => {
    expect(await traverse([])).toContain(', 0% packet loss');
  });

  it('`deny ip any any` en sortie l\'arrete', async () => {
    expect(await traverse(DENY_SORTANT)).toContain(', 100% packet loss');
  });
});
