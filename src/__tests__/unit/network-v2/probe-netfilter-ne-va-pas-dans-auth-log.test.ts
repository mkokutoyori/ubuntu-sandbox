/*
 * Un paquet jete par netfilter s'ecrivait DEUX fois, dans deux fichiers,
 * en deux formats, par deux ecrivains.
 *
 * `LinuxMachine.runFilterTable` appelle `logIptablesDrop` — la trace
 * fidele, facilite `kern`, deja epinglee par `logging-enhancements`
 * (« a dropped INPUT packet writes a netfilter line to kern.log ») :
 *
 *   kernel: netfilter: [netfilter DROP] IN=eth0 OUT= SRC=... DST=... PROTO=TCP SPT=... DPT=...
 *
 * et publie `linux.firewall.drop`, que `IamAuthLogProjection` — la
 * projection des evenements IAM — reprenait pour ecrire une SECONDE
 * trace du meme paquet dans `/var/log/auth.log` :
 *
 *   audit[112]: netfilter INPUT: src=10.0.10.10:32768 dst=10.0.30.10:22 proto=TCP in=eth0 out=
 *
 * Deux ecritures d'un seul fait ne restent pas egales, et celle-ci est
 * en plus dans le mauvais fichier. La cible LOG d'iptables journalise
 * par le JOURNAL DU NOYAU (`iptables-extensions(8)`), donc facilite
 * `kern` -> `/var/log/kern.log` ; `auth`/`authpriv` est le systeme
 * d'authentification des utilisateurs, et `routeLogFiles` de ce depot
 * encode deja cette table de Debian. Aucun hote reel n'ecrit un verdict
 * netfilter dans `auth.log` — le sous-systeme d'audit, quand il existe,
 * a son propre `/var/log/audit/audit.log`.
 *
 * Le cout se voit a la lecture : `auth.log` est le fichier qu'on ouvre
 * pour savoir QUI a tente de se connecter. Y melanger les paquets
 * filtres fait passer une adresse que le pare-feu a jetee AVANT tout
 * dialogue pour une adresse qui a parle au sshd. C'est le defaut que
 * `scenario-multilayer-acl-coherence` mesure sous le nom « point de
 * blocage unique » : chaque client bloque doit laisser une trace a UNE
 * seule couche.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 2 des 5 cas tombent.
 * Les 3 autres sont nommes :
 *
 *   - « kern.log porte le verdict » est le TEMOIN. Il passe des deux
 *     cotes, et c'est tout son interet : il prouve que le laboratoire
 *     jette bien un paquet. Sans lui, l'absence dans `auth.log` serait
 *     satisfaite par un laboratoire ou rien n'est filtre.
 *   - « auth.log garde ses vraies traces » est une NON-REGRESSION :
 *     retirer un abonnement de trop ne doit pas emporter les treize
 *     autres, ceux du domaine IAM.
 *   - « le meme verdict n'est ecrit qu'une fois » est STRUCTUREL : il
 *     compte les occurrences toutes facilites confondues, donc il
 *     tombait avant pour la meme raison que le cas `auth.log`, mais il
 *     dit une chose de plus — que la correction supprime la copie au
 *     lieu de la deplacer ailleurs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  client: LinuxPC;
  server: LinuxServer;
}

async function labFiltre(): Promise<Lab> {
  const client = new LinuxPC('CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.powerOn();
  server.powerOn();
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  const m = new SubnetMask('255.255.255.0');
  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), m);
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), m);
  await server.executeCommand('iptables -A INPUT -p tcp --dport 23 -j DROP');
  client.getTcpStack().connect('10.0.0.2', 23);
  return { client, server };
}

describe('un verdict netfilter appartient au journal du NOYAU', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('kern.log porte le verdict — le TEMOIN', async () => {
    const { server } = await labFiltre();
    expect(await server.executeCommand('cat /var/log/kern.log'))
      .toMatch(/\[netfilter DROP\] IN=eth0.+SRC=10\.0\.0\.1 DST=10\.0\.0\.2 PROTO=TCP.+DPT=23/);
  });

  it('auth.log n\'en porte AUCUNE trace', async () => {
    const { server } = await labFiltre();
    const auth = await server.executeCommand('cat /var/log/auth.log');
    expect(auth, 'un verdict netfilter est ecrit dans auth.log').not.toMatch(/netfilter/);
    expect(auth, 'l\'adresse du paquet filtre est ecrite dans auth.log')
      .not.toMatch(/10\.0\.0\.1\b/);
  });

  it('le meme verdict n\'est ecrit qu\'une fois, toutes facilites confondues', async () => {
    const { server } = await labFiltre();
    const journal = String(await server.executeCommand('journalctl'));
    const lignes = journal.split('\n').filter((l) => l.includes('netfilter'));
    expect(lignes, 'le verdict est journalise plus d\'une fois').toHaveLength(1);
  });

  it('auth.log garde ses vraies traces d\'authentification — NON-REGRESSION', async () => {
    const { server } = await labFiltre();
    await server.executeCommand('useradd -m zoe');
    const auth = await server.executeCommand('cat /var/log/auth.log');
    expect(auth, 'la creation de compte ne se journalise plus').toMatch(/useradd.+new user: name=zoe/);
  });

  it('le journal du noyau distingue REJECT de DROP — NON-REGRESSION', async () => {
    const client = new LinuxPC('CLI2');
    client.powerOn();
    client.getPort('eth0')!.configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    await client.executeCommand('sudo iptables -A OUTPUT -p udp --dport 9999 -j REJECT');
    (client as unknown as {
      sendUdpDatagram: (d: IPAddress, dp: number, sp: number, p: string, s: number) => boolean;
    }).sendUdpDatagram(new IPAddress('10.0.1.2'), 9999, 5000, 'x', 1);
    const dmesg = await client.executeCommand('dmesg');
    expect(dmesg).toMatch(/\[netfilter REJECT\][^\n]*DPT=9999/);
    expect(dmesg).not.toMatch(/\[netfilter DROP\][^\n]*DPT=9999/);
  });
});
