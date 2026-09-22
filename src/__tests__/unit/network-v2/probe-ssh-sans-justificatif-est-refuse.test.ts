/*
 * Un `ssh` qui n'offre AUCUN justificatif etait servi.
 *
 * Mesure de depart, depuis un poste Linux, vers chaque famille
 * d'equipement du depot, comptes existants et mots de passe poses :
 *
 *   ssh bob@<cisco> "show version"      rend la sortie de la commande
 *   ssh User@<windows> "hostname"       rend le nom de la machine
 *   ssh alice@<linux> hostname          rend le nom de la machine
 *   ssh admin@<fortigate> "get ..."     Permission denied
 *
 * Aucun mot de passe n'est offert dans ces quatre appels. Trois d'entre
 * eux ouvrent une session. Le quatrieme la refuse — et c'est lui qui a
 * raison, parce que le pare-feu est le seul dont l'authentification
 * passe par le FIL.
 *
 * L'AUTORITE EST UNE NORME ADOPTEE, et elle est vendor-neutre, ce qui
 * importe ici puisque UN SEUL chemin sert Cisco, Huawei et Windows.
 * RFC 4252 §5.2, sur la methode « none » — celle que le client emploie
 * quand il n'a rien a offrir :
 *
 *   « The server MUST always reject this request, unless the client is
 *     to be granted access without any authentication, in which case,
 *     the server MUST accept this request. »
 *
 * Et §5 place le demarrage du service APRES le succes : le serveur
 * n'ouvre le canal qu'une fois `SSH_MSG_USERAUTH_SUCCESS` emis. Un
 * `show version` rendu sans authentification n'est donc pas une
 * indulgence, c'est un canal ouvert avant l'heure.
 *
 * LA CAUSE EST UN DUPLICAT, et le duplicat est le plus permissif des
 * deux. La question « ce serveur accepte-t-il sans justificatif ? » a
 * deja une ecriture cote FIL : `ISshAuthContext.acceptsWithoutCredential`,
 * que `SshServerHandler` consulte avec un defaut ferme
 * (`?? false`). Le chemin cross-vendor en portait une SECONDE, ecrite a
 * la main au milieu de la negociation :
 *
 *     } else if (account || this.authority.count() === 0) {
 *       return 'password';
 *     }
 *
 * « le compte existe » y tenait lieu d'authentification. Le `account ||`
 * disparait ; ce qui reste — `authority.count() === 0` — est
 * exactement la clause d'exception de la RFC : un equipement sans aucun
 * compte declare est un equipement dont l'acces ne demande rien, comme
 * une `line vty` sans `login`. Cette moitie-la doit RESTER.
 *
 * Cote Linux, `acceptsWithoutCredential` rendait vrai des que le compte
 * existait — la meme indulgence, ecrite au bon endroit mais avec la
 * mauvaise reponse. L'implementation disparait et le defaut ferme du
 * contrat s'applique.
 *
 * CE QUE CELA CHANGE POUR LES TESTS, et c'est dit plutot que subi : une
 * cinquantaine de cas du depot tapaient `ssh alice@hote commande` sans
 * rien offrir et attendaient la sortie. Ils decrivaient un operateur
 * qui tape son mot de passe ; ils le fournissent desormais par l'entree
 * standard, que `executeCommand(cmd, stdin)` porte depuis toujours et
 * dont d'autres sondes se servent deja. Aucun n'a ete affaibli : ils
 * verifient la meme sortie, apres une authentification qui a lieu.
 *
 * DEUX CHOSES MESUREES EN CHEMIN, dites ici plutot que laissees a
 * redecouvrir.
 *
 * L'ASA repondait « % Invalid input detected at '^' marker. » a TOUT
 * `show` recu par SSH, alors que le meme `show version` tape sur sa
 * console rendait sa banniere : sa session s'ouvrait dans un mode ou le
 * vocabulaire `show` n'existe pas. Ce defaut etait DISTINCT de celui-ci
 * — il porte sur le mode d'une session, pas sur l'authentification — et
 * le fermer ici aurait melange deux mesures, d'ou la preuve « la CLI a
 * repondu » retenue alors. Il a ete ferme depuis, dans son propre lot :
 * l'ASA ouvre desormais au niveau que sa base locale donne au compte, et
 * la preuve retenue ici est la BANNIERE, qui etablit la meme chose en
 * plus fort.
 *
 * La clause d'exception de la RFC n'est demontree par AUCUN cas, et
 * c'est volontaire. Une `line vty` sans `login local` ne se laisse pas
 * joindre en SSH sur un IOS reel — il n'y a pas de methode
 * d'authentification a appliquer — et le simulateur la refuse aussi. Le
 * garde `authority.count() === 0` reste donc dans le code parce qu'il
 * EST la clause, mais aucune configuration d'equipement de ce
 * laboratoire ne l'atteint, et une sonde qui pretendrait le contraire
 * affirmerait une premisse fausse.
 *
 * Ecrite a l'aveugle contre la RFC et contre ce que fait une vraie
 * machine.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 18 cas tombent — les quatre familles NON pare-feu du bloc
 * « sans justificatif ». Les 14 autres sont nommes ici :
 *
 *  - LE PARE-FEU, des DEUX cotes. FortiGate et ASA refusaient deja,
 *    parce que leur authentification traverse le fil depuis le lot
 *    « ssh vers un pare-feu ». Ce sont les TEMOINS : ils montrent que la
 *    reponse juste existait deja dans le depot, et que ce lot l'etend
 *    aux autres familles au lieu de l'inventer.
 *  - LE MAUVAIS MOT DE PASSE, partout. Il etait deja refuse ; sans lui,
 *    une sonde qui ne mesure que le cas vide ne prouverait pas que le
 *    verrou tient encore.
 *  - LE BON MOT DE PASSE, partout. Il passait deja et doit continuer :
 *    c'est le cas qui tombe si l'on « corrige » en refusant tout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASQUE = new SubnetMask('255.255.255.0');
const SECRET = 'Secret123';

const POSTE = '10.0.0.9';
const LINUX = '10.0.0.3';
const CISCO = '10.0.0.6';
const HUAWEI = '10.0.0.8';
const WINDOWS = '10.0.0.4';
const FORTI = '10.0.0.2';
const ASA = '10.0.0.5';

interface Cmd { executeCommand(c: string, extra?: never): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function laboratoire() {
  const poste = new LinuxPC('linux-pc', 'PC', -200, 0);
  const linux = new LinuxServer('linux-server', 'SRV', 200, 0);
  const cisco = new CiscoRouter('R1', 200, 100);
  const huawei = new HuaweiRouter('AR1', 200, 200);
  const windows = new WindowsPC('windows-pc', 'WIN', 200, 300);
  const forti = new FortiGate('firewall-fortinet', 'FGT', 200, 400);
  const asa = new AsaFirewall('firewall-cisco', 'ASA', 200, 500);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  commutateur.powerOn(); poste.powerOn(); linux.powerOn();
  cisco.powerOn(); huawei.powerOn(); windows.powerOn();

  const brancher = (port: unknown, index: number, nom: string) =>
    new Cable(nom).connect(port as never, commutateur.getPorts()[index]);
  brancher(poste.getPort('eth0'), 0, 'c0');
  brancher(linux.getPorts()[0], 1, 'c1');
  brancher(cisco.getPorts()[0], 2, 'c2');
  brancher(huawei.getPorts()[0], 3, 'c3');
  brancher(windows.getPorts()[0], 4, 'c4');
  brancher(forti.getPort('port1'), 5, 'c5');
  brancher(asa.getPorts()[0], 6, 'c6');

  await runOn(poste, ['ip link set eth0 up', `ip addr add ${POSTE}/24 dev eth0`]);

  linux.getPorts()[0].configureIP(new IPAddress(LINUX), MASQUE);
  await runOn(linux, ['ip link set eth0 up', 'useradd -m alice', `echo alice:${SECRET} | chpasswd`]);

  windows.getPorts()[0].configureIP(new IPAddress(WINDOWS), MASQUE);
  const gestionnaire = (windows as unknown as { userMgr: { currentUser: string } }).userMgr;
  const avant = gestionnaire.currentUser;
  gestionnaire.currentUser = 'Administrator';
  await runOn(windows, [`net user User ${SECRET}`]);
  gestionnaire.currentUser = avant;

  await runOn(cisco, [
    'enable', 'configure terminal', 'hostname R1',
    `username bob privilege 15 secret ${SECRET}`, 'ip domain-name lab.local',
    'crypto key generate rsa modulus 1024', 'line vty 0 4',
    'transport input ssh', 'login local', 'exit',
    'interface GigabitEthernet0/0', `ip address ${CISCO} 255.255.255.0`,
    'no shutdown', 'end',
  ]);

  await runOn(huawei, [
    'system-view', 'sysname AR1', 'stelnet server enable',
    `aaa`, `local-user bob password cipher ${SECRET}`,
    'local-user bob service-type ssh', 'local-user bob privilege level 15', 'quit',
    'ssh user bob authentication-type password',
    'interface GigabitEthernet0/0/0', `ip address ${HUAWEI} 255.255.255.0`,
    'quit', 'quit',
  ]);

  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${FORTI} 255.255.255.0`, 'set allowaccess ping https ssh', 'next', 'end',
    'config system admin', 'edit "admin"', `set password "${SECRET}"`,
    'set accprofile "super_admin"', 'next', 'end',
  ]) forti.getShell().execute(ligne);

  await runOn(asa, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'nameif inside', 'security-level 100',
    `ip address ${ASA} 255.255.255.0`, 'no shutdown', 'exit',
    `username admin password ${SECRET} privilege 15`,
    'aaa authentication ssh console LOCAL',
    'ssh 10.0.0.0 255.255.255.0 inside', 'end',
  ]);

  return { poste, linux, cisco, huawei, windows, forti, asa };
}

interface Cible {
  readonly nom: string;
  readonly ip: string;
  readonly compte: string;
  readonly commande: string;
  readonly preuve: RegExp;
}

const CIBLES: readonly Cible[] = [
  { nom: 'linux', ip: LINUX, compte: 'alice', commande: 'hostname', preuve: /linux-server/ },
  { nom: 'cisco', ip: CISCO, compte: 'bob', commande: '"show version"', preuve: /Cisco IOS Software/ },
  { nom: 'huawei', ip: HUAWEI, compte: 'bob', commande: '"display version"', preuve: /Huawei|VRP/ },
  { nom: 'windows', ip: WINDOWS, compte: 'User', commande: 'hostname', preuve: /windows-pc|WIN/i },
  { nom: 'fortigate', ip: FORTI, compte: 'admin', commande: '"get system status"', preuve: /Version:/ },
  { nom: 'asa', ip: ASA, compte: 'admin', commande: '"show version"', preuve: /Adaptive Security/ },
];

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('sans AUCUN justificatif, le serveur refuse — RFC 4252 §5.2', () => {
  it.each(CIBLES)('vers un $nom', async (cible) => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `ssh ${cible.compte}@${cible.ip} ${cible.commande}`);

    expect(sortie, sortie).toMatch(/Permission denied/);
    expect(sortie, sortie).not.toMatch(cible.preuve);
  }, 60000);
});

describe('avec le BON mot de passe, la commande s\'execute — les TEMOINS', () => {
  it.each(CIBLES)('vers un $nom', async (cible) => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `sshpass -p ${SECRET} ssh ${cible.compte}@${cible.ip} ${cible.commande}`);

    expect(sortie, sortie).toMatch(cible.preuve);
  }, 60000);
});

describe('avec un MAUVAIS mot de passe, le serveur refuse — les TEMOINS', () => {
  it.each(CIBLES)('vers un $nom', async (cible) => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `sshpass -p MAUVAIS ssh ${cible.compte}@${cible.ip} ${cible.commande}`);

    expect(sortie, sortie).not.toMatch(cible.preuve);
  }, 60000);
});
