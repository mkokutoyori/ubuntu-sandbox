/*
 * `scp` et `sftp` ne savaient pas ECRIRE une adresse IPv6.
 *
 * Mesure de depart, sur un LAN ou le poste et le serveur partagent
 * `2001:db8::/64` et ou `ssh` vers ce meme serveur fonctionne :
 *
 *   scp f.txt alice@10.0.10.6:/tmp/g.txt        f.txt  100%  8  8B/s
 *   scp f.txt alice@[2001:db8::6]:/tmp/h.txt    Could not resolve hostname alice@[2001
 *   scp f.txt alice@2001:db8::6:/tmp/i.txt      Could not resolve hostname 2001
 *   sftp alice@[2001:db8::6]                    Could not resolve hostname alice@[2001
 *
 * « alice@[2001 » et « 2001 » disent la cause sans ambiguite : la
 * destination est coupee au PREMIER deux-points, qui en IPv6 tombe au
 * milieu de l'adresse.
 *
 * LA CAUSE EST UNE REUSSITE PARTIELLE DE LA REUTILISATION, le piege que
 * `CLAUDE.md` nomme : « a partial reuse is still a duplication ». Le
 * depot porte `parseScpEndpoint`, qui analyse `[user@]host:path` et dont
 * le commentaire dit la regle d'OpenSSH — le premier `:` AVANT tout `/`
 * marque un point distant. `ScpSession` s'en sert pour le transfert.
 * Mais `LinuxCommandExecutor` extrait l'hote a la main pour la SONDE qui
 * precede le transfert, et il le fait DEUX fois, aux deux variantes de
 * `runSshTransport` :
 *
 *     const hostPart = dest.replace(/^([\w.-]+@)?/, '').split(':')[0];
 *
 * Une troisieme ecriture de la meme question, plus permissive que les
 * deux autres puisqu'elle ne connait ni les crochets ni la regle du
 * `/`. Elle est supprimee, pas corrigee : les deux sites appellent
 * `parseScpEndpoint`.
 *
 * LA REGLE EST CELLE D'OPENSSH, et elle differe de celle de `ssh`. Un
 * `ssh` accepte le litteral IPv6 NU (`ssh alice@2001:db8::6`) parce
 * qu'aucun `:path` ne suit. `scp` et `sftp` exigent les CROCHETS, parce
 * que le deux-points y separe deja l'hote du chemin ; c'est la meme
 * raison qui impose les crochets dans une URL. La forme nue reste donc
 * refusee ici, et c'est le comportement de la vraie commande, pas une
 * limite.
 *
 * Ecrite a l'aveugle contre `scp(1)` et `sftp(1)`.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 9 cas tombent. Les 4 autres sont nommes ici, et aucun ne prouve
 * le mecanisme :
 *
 *  - TEMOIN DU FIL ET DE LA PILE : `ssh alice@2001:db8::6 hostname`
 *    repond deja. Sans lui, « l'IPv6 ne marche pas pour les
 *    transferts » et « seule l'ECRITURE de l'adresse est en cause »
 *    seraient indiscernables.
 *  - TEMOINS IPv4 : un `scp` et un `sftp` vers l'adresse v4 du meme
 *    serveur marchent des deux cotes. Ils mesurent ce que le correctif
 *    ne doit pas casser — c'est le chemin que tout le reste du depot
 *    emprunte.
 *  - NON-REGRESSION DE LA REGLE : la forme NUE `alice@2001:db8::6:/tmp`
 *    doit RESTER refusee, comme sur une vraie machine. Elle tombe si
 *    l'on « corrige » en acceptant tout ce qui ressemble a une adresse,
 *    ce qui rendrait un chemin local a deux-points indistinguable d'un
 *    hote.
 *
 * UN CAS A CHANGE DE SENS EN COURS DE ROUTE, et il est dit ici plutot
 * que corrige en silence. Il affirmait d'abord qu'un `scp` d'un fichier
 * local vers un autre TRANSFERE. C'est une premisse fausse : le
 * simulateur REFUSE deliberement le local-a-local, dans ses propres
 * mots — « both endpoints local — use cp instead » — et c'est
 * `ScpTransfer` qui le decide. Le cas mesure donc ce qui relevait
 * vraiment de ce lot : un chemin local n'est plus pris pour un HOTE. Il
 * tombe quand meme, parce que l'ancienne extraction envoyait
 * `/tmp/f.txt` a la resolution de noms ; ce qu'il gagne, c'est de ne
 * plus exiger du moteur un comportement qu'il refuse expressement.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SERVEUR_V4 = '10.0.10.6';
const SERVEUR_V6 = '2001:db8::6';
const POSTE_V4 = '10.0.10.9';
const POSTE_V6 = '2001:db8::9';
const SECRET = 'S3cret';

interface Cmd { executeCommand(c: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  const serveur = new LinuxServer('linux-server', 'SRV', 150, 0);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  commutateur.powerOn(); poste.powerOn(); serveur.powerOn();

  new Cable('a').connect(poste.getPort('eth0')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(serveur.getPorts()[0], commutateur.getPort('eth1')!);

  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR_V4), new SubnetMask('255.255.255.0'));
  await runOn(poste, [
    'ip link set eth0 up', `ip addr add ${POSTE_V4}/24 dev eth0`,
    `ip -6 addr add ${POSTE_V6}/64 dev eth0`,
    'echo bonjour > /tmp/f.txt',
  ]);
  await runOn(serveur, [
    'ip link set eth0 up', `ip -6 addr add ${SERVEUR_V6}/64 dev eth0`,
    'useradd -m alice', `echo alice:${SECRET} | chpasswd`,
  ]);

  return { poste, serveur };
}

describe('la pile repond deja en IPv6 — le TEMOIN', () => {
  it('`ssh` vers le litteral joint le serveur', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(
      `sshpass -p ${SECRET} ssh alice@${SERVEUR_V6} hostname`)).toMatch(/linux-server/);
  });
});

describe('`scp` adresse un hote IPv6 entre CROCHETS', () => {
  it('le fichier arrive vraiment sur le serveur', async () => {
    const { poste, serveur } = await laboratoire();

    await poste.executeCommand(
      `sshpass -p ${SECRET} scp /tmp/f.txt alice@[${SERVEUR_V6}]:/tmp/h.txt`);

    expect(await serveur.executeCommand('cat /tmp/h.txt')).toMatch(/bonjour/);
  });

  it('et la sonde ne parle plus d\'un hote tronque', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `sshpass -p ${SECRET} scp /tmp/f.txt alice@[${SERVEUR_V6}]:/tmp/h2.txt`);

    expect(sortie).not.toMatch(/Could not resolve/);
  });

  it('la direction inverse fonctionne aussi', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['echo retour > /tmp/r.txt', 'chmod 644 /tmp/r.txt']);

    await poste.executeCommand(
      `sshpass -p ${SECRET} scp alice@[${SERVEUR_V6}]:/tmp/r.txt /tmp/r.txt`);

    expect(await poste.executeCommand('cat /tmp/r.txt')).toMatch(/retour/);
  });
});

describe('`sftp` aussi', () => {
  it('la session s\'ouvre sur le litteral entre crochets', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `sshpass -p ${SECRET} sftp alice@[${SERVEUR_V6}]`);

    expect(sortie).not.toMatch(/Could not resolve/);
    expect(sortie).toMatch(/Connected to/);
  });
});

describe('ce que le correctif ne doit pas casser', () => {
  it('`scp` vers l\'adresse IPv4 du meme serveur — le TEMOIN', async () => {
    const { poste, serveur } = await laboratoire();

    await poste.executeCommand(
      `sshpass -p ${SECRET} scp /tmp/f.txt alice@${SERVEUR_V4}:/tmp/g.txt`);

    expect(await serveur.executeCommand('cat /tmp/g.txt')).toMatch(/bonjour/);
  });

  it('`sftp` vers l\'adresse IPv4 — le TEMOIN', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`sshpass -p ${SECRET} sftp alice@${SERVEUR_V4}`))
      .toMatch(/Connected to/);
  });

  it('la forme NUE reste refusee, comme sur une vraie machine', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(
      `sshpass -p ${SECRET} scp /tmp/f.txt alice@${SERVEUR_V6}:/tmp/nu.txt`))
      .toMatch(/Could not resolve|no route to host/);
  });

  it('deux chemins LOCAUX ne partent plus chercher un hote', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand('scp /tmp/f.txt /tmp/local.txt');

    expect(sortie).not.toMatch(/Could not resolve/);
    expect(sortie).toMatch(/both endpoints local/);
  });
});
