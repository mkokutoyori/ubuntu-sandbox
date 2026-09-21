/*
 * `telnet` vers une interface qui JETTE disait « Connection refused ».
 *
 * Trois vues de la meme machine, au meme instant, pour le meme paquet —
 * un FortiGate dont le `port1` porte `set allowaccess ping https`, donc
 * ni `ssh` ni `telnet` :
 *
 *   nc -zv -w 1 10.0.10.2 23   nc: connect to ... failed: Connection timed out
 *   ssh admin@10.0.10.2        ssh: ... : Connection timed out
 *   telnet 10.0.10.2           telnet: connect to address ...: Connection refused
 *
 * Les deux premieres sont justes — la politique local-in implicite de
 * FortiOS JETTE ce qui n'est pas dans `allowaccess`, et un paquet jete
 * ne rend rien. La troisieme envoie l'operateur chercher un service
 * arrete la ou il faut lire une regle de filtrage. C'est le meme
 * diagnostic inverse que les lots `ssh` viennent de fermer, reste
 * ouvert sur l'autre protocole d'administration.
 *
 * LA CAUSE EST UN DUPLICAT, et c'est lui qui explique pourquoi la
 * correction de `ssh` n'a pas emporte `telnet` avec elle. La question
 * « qu'a repondu le fil ? » est ecrite TROIS fois sur une machine
 * Linux, et chaque ecriture perd quelque chose d'autre :
 *
 *   setTcpProbe    (ip, port) => boolean          perd le MOTIF
 *   setWireProbe   (ip, port) => TcpWireOutcome   perd l'IPv6
 *   tcpConnectOutcome (contexte de commande)      complete
 *
 * Le client telnet lisait la premiere. Un booleen ne peut pas
 * distinguer « ferme » de « filtre », donc il rendait le seul mot qu'il
 * connaissait. `setTcpProbe` n'avait QU'UN lecteur — celui-la — et
 * disparait ; `setWireProbe` gagne l'aiguillage des deux familles
 * d'adresses que la troisieme ecriture portait deja.
 *
 * Ce n'est pas une sonde de plus : le chemin en tirait deja une, et
 * elle rend desormais cinq valeurs au lieu de deux.
 *
 * Ecrite a l'aveugle contre le client BSD, dont `telnet.c` rend
 * `strerror(errno)` : ECONNREFUSED « Connection refused » quand un RST
 * revient, ETIMEDOUT « Connection timed out » quand rien ne revient.
 *
 * La limite IPv6 que cette sonde portait — `telnet` vers une adresse
 * IPv6 rendait « No route to host » alors meme que le port ecoutait — a
 * ete FERMEE par `probe-le-chemin-existe-aussi-en-ipv6`, qui l'a trouvee
 * plus large qu'elle n'y paraissait : la marche du plan de cables et les
 * deux clients ssh la partageaient. Le cas qui la posait est donc retire
 * d'ici plutot que garde en contrat d'un defaut corrige.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 2 des 6 cas tombent. Les 4 autres sont nommes ici, et aucun ne prouve
 * le mecanisme :
 *
 *  - TEMOINS du fil : `nc` et `ssh` disaient DEJA « timed out » pour ce
 *    paquet. Ce sont les vues justes dont `telnet` divergeait, et sans
 *    elles « le pare-feu refuse » et « le client se trompe » seraient
 *    indiscernables.
 *  - TEMOIN de la porte ouverte : avec `telnet` dans `allowaccess`, la
 *    session atteint « FGT login: ». Il passe des deux cotes et dit que
 *    le correctif n'a pas ferme la porte en corrigeant le mot.
 *  - NON-REGRESSION du vrai refus : un port ou RIEN n'ecoute doit
 *    RESTER « Connection refused ». C'est le cas qui tombe si l'on
 *    remplace le refus par un silence au lieu de le faire dependre du
 *    fil.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const PARE_FEU = '10.0.10.2';
const SERVEUR = '10.0.10.6';
const POSTE = '10.0.10.9';
const SERVEUR_V6 = '2001:db8::6';

interface Cmd { executeCommand(c: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function laboratoire(allowaccess = 'ping https') {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const pareFeu = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  const serveur = new LinuxServer('linux-server', 'SRV', -150, 200);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  commutateur.powerOn(); poste.powerOn(); serveur.powerOn();

  new Cable('a').connect(pareFeu.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(poste.getPort('eth0')!, commutateur.getPort('eth1')!);
  new Cable('c').connect(serveur.getPorts()[0], commutateur.getPort('eth2')!);

  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${PARE_FEU} 255.255.255.0`, `set allowaccess ${allowaccess}`, 'next', 'end',
  ]) pareFeu.getShell().execute(ligne);
  for (const ligne of [
    'config system admin', 'edit "admin"', 'set password "Secret123"',
    'set accprofile "super_admin"', 'next', 'end',
  ]) pareFeu.getShell().execute(ligne);

  await runOn(poste, [
    'ip link set eth0 up', `ip addr add ${POSTE}/24 dev eth0`,
  ]);
  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR), new SubnetMask('255.255.255.0'));
  await runOn(serveur, ['ip link set eth0 up', `ip -6 addr add ${SERVEUR_V6}/64 dev eth0`]);

  return { pareFeu, poste, serveur };
}

describe('un paquet JETE est un silence, pour telnet aussi', () => {
  it('`telnet` ne dit plus « refused »', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(`telnet ${PARE_FEU}`);

    expect(sortie).not.toMatch(/Connection refused/);
  });

  it('il dit le SILENCE, comme les autres vues', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`telnet ${PARE_FEU}`))
      .toMatch(/Connection timed out/);
  });

  it('`nc` le disait deja — le TEMOIN', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`nc -zv -w 1 ${PARE_FEU} 23`))
      .toMatch(/Connection timed out/);
  });

  it('`ssh` le disait deja aussi — le TEMOIN', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`ssh admin@${PARE_FEU}`))
      .toMatch(/Connection timed out/);
  });
});

describe('ce que le correctif ne doit pas casser', () => {
  it('avec `telnet` dans `allowaccess`, la session atteint l\'invite', async () => {
    const { poste } = await laboratoire('ping https ssh telnet');

    expect(await poste.executeCommand(`telnet ${PARE_FEU}`))
      .toMatch(/FGT login:/);
  });

  it('un port ou RIEN n\'ecoute reste un vrai refus', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`telnet ${SERVEUR}`))
      .toMatch(/Connection refused/);
  });
});
