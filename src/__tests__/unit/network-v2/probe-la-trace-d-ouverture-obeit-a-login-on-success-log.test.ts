/*
 * La trace d'une ouverture de session SSH obeit a `login on-success log`,
 * et a lui seul.
 *
 * Cette sonde REMPLACE `probe-le-journal-de-securite-est-du-syslog`, qui
 * epinglait un defaut comme contrat. Elle affirmait qu'apres une ouverture
 * de session SSH reussie, `show logging` devait porter
 * `%SEC_LOGIN-5-LOGIN_SUCCESS` — sans que le laboratoire ait tape
 * `login on-success log`. C'est faux sur IOS : ces deux messages sont
 * produits par la fonction « Login Enhancements », que l'operateur arme
 * avec `login on-success log` / `login on-failure log` ; sans elles, IOS
 * ne les ecrit pas. `tuto-sessions-journal-et-lignes` le mesurait deja, et
 * rougissait depuis.
 *
 * LE DEFAUT ETAIT UN DUPLICAT, ET LE PLUS PERMISSIF GAGNAIT. Deux
 * abonnes ecrivaient la meme ligne dans le meme tampon a partir du meme
 * evenement du bus :
 *
 *   LoggingConfig      login.success -> %SEC_LOGIN-5  SI logSuccess()
 *   SecurityAuditLog   login.success -> %SEC_LOGIN-5  TOUJOURS  (le pont)
 *
 * Le second, ajoute par le lot qui a ecrit la sonde remplacee, ne lisait
 * aucun des deux drapeaux, ecrivait sa propre formulation
 * (`[Reason: Login Authentication]` en queue d'une reussite, ce qu'aucun
 * IOS n'ecrit), et faisait aussi traverser le pont a des lignes que rien
 * ne source — `Account alice created with privilege 1` pour chaque compte
 * d'usine, dans le tampon d'un routeur a qui l'on n'avait rien tape. Le
 * pont est SUPPRIME ; `SecurityAuditLog` reste le registre structure que
 * `show login failures` releve, et n'ecrit plus dans le journal.
 *
 * Ce que le lot remplace avait trouve de VRAI survit, et c'est ce que
 * cette sonde mesure en premier lieu : l'ouverture de session sur le FIL
 * n'emettait aucun `login.success` — `RouterSshServerContext` n'avait pas
 * de crochet `recordLogin`. Il en a un. C'est pourquoi, drapeau arme, la
 * ligne parait bien apres une vraie session SSH, et non seulement apres un
 * appel direct au magasin de comptes comme dans le tutoriel.
 *
 * L'AUTORITE est la documentation Cisco de `login on-success log` et
 * `login on-failure log` (Login Enhancements, IOS 12.3) ; la formulation
 * est celle que `tuto-sessions-journal-et-lignes` a relevee sur des
 * transcriptions reelles.
 *
 * UNE SECONDE MAIN AVAIT POSE UNE PORTE SUR LE PONT au lieu de le
 * retirer : `Router.loginEventIsLogged`, qui lit les deux drapeaux avant
 * d'ecrire. Les cas « sans drapeau » en etaient repares ; mais drapeau
 * arme, les DEUX abonnes ecrivaient, et une seule ouverture laissait deux
 * `%SEC_LOGIN-5-LOGIN_SUCCESS` de formulations differentes — mesure, sur
 * le fil comme par un appel direct au magasin. Une porte sur un duplicat
 * garde le duplicat ; c'est pourquoi le pont est retire, et non garde.
 *
 * Discriminee contre DEUX etats d'avant, parce qu'il y en a eu deux :
 *
 *  - le pont SANS porte (`547054cd`) : 3 des 8 cas tombent, les deux
 *    « sans drapeau, rien » et « une ouverture laisse une ligne, pas
 *    deux » ;
 *  - le pont AVEC porte (`46cee8f6`) : 1 des 8 tombe, « une ligne, pas
 *    deux » — les deux cas « sans drapeau » y passent, la porte les
 *    ayant repares.
 *
 * Les 5 autres passent des deux cotes dans les deux mesures :
 *
 *  - TEMOINS DU FIL, Cisco et Huawei : la session s'ouvre et rend la
 *    sortie du routeur des deux cotes. Sans eux, « rien n'est journalise »
 *    et « la connexion a echoue » seraient indiscernables.
 *  - DRAPEAU ARME, reussite et echec : la ligne parait des deux cotes —
 *    avant par les DEUX abonnes a la fois, apres par le seul qui lit le
 *    drapeau. Ils disent que le correctif n'a pas emporte l'emetteur juste
 *    avec le faux.
 *  - Huawei `display logbuffer` porte la trace de l'ouverture des deux
 *    cotes : c'est `%SSH-5-SSH2_SESSION` qui la porte sur VRP, pas
 *    `%SEC_LOGIN`, et celui-la ne passait pas par le pont. Que VRP ecrive
 *    ou non une ligne de type `SEC_LOGIN` par defaut n'est pas sourcable
 *    d'ici — les deux domaines de documentation Huawei sont bloques par
 *    le mandataire de sortie — donc rien n'est invente de ce cote.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';
const POSTE_IP = '10.0.0.1';
const SECRET = 'Admin@123';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(
  ...loginLogging: string[]
): Promise<{ r1: CiscoRouter; ar1: HuaweiRouter; poste: LinuxPC }> {
  const r1 = new CiscoRouter('R1');
  const ar1 = new HuaweiRouter('AR1');
  const poste = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(poste.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(ar1.getPort('GE0/0/0')!, sw.getPorts()[2]);

  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    `username admin privilege 15 secret ${SECRET}`,
    `enable secret ${SECRET}`,
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'ip ssh version 2',
    ...loginLogging,
    'interface GigabitEthernet0/0',
    `ip address ${CISCO_IP} 255.255.255.0`,
    'no shutdown', 'exit',
    'line vty 0 4', 'login local', 'transport input ssh', 'exit',
    'end',
  ]) await r1.executeCommand(c);

  for (const c of [
    'system-view',
    'interface GigabitEthernet 0/0/0',
    `ip address ${HUAWEI_IP} 24`,
    'undo shutdown', 'quit',
    'rsa local-key-pair create',
    'stelnet server enable',
    'aaa',
    `local-user admin password cipher ${SECRET}`,
    'local-user admin privilege level 15',
    'local-user admin service-type ssh',
    'quit',
    'user-interface vty 0 4',
    'authentication-mode aaa',
    'protocol inbound ssh',
    'quit', 'return',
  ]) await ar1.executeCommand(c);

  await poste.executeCommand(`ifconfig eth0 ${POSTE_IP} netmask 255.255.255.0`);
  return { r1, ar1, poste };
}

const parSsh = (poste: LinuxPC, ip: string, commande: string): Promise<string> =>
  poste.executeCommand(`ssh admin@${ip} "${commande}"`, `${SECRET}\n`);

const echecSsh = (poste: LinuxPC): Promise<string> =>
  poste.executeCommand(
    `ssh -o NumberOfPasswordPrompts=1 admin@${CISCO_IP} "show clock"`, 'faux\n');

describe('la session s\'ouvre vraiment — les TEMOINS', () => {
  it('Cisco rend la sortie de sa commande distante', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, CISCO_IP, 'show clock')).not.toMatch(/Permission denied/);
  });

  it('Huawei aussi', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, HUAWEI_IP, 'display version')).toMatch(/VRP|Huawei|Version/i);
  });
});

describe('sans `login on-success log` ni `login on-failure log`, IOS n\'ecrit rien', () => {
  it('une ouverture reussie ne laisse pas de %SEC_LOGIN-5', async () => {
    const { r1, poste } = await laboratoire();
    await parSsh(poste, CISCO_IP, 'show clock');

    expect(await r1.executeCommand('show logging')).not.toMatch(/%SEC_LOGIN-5-LOGIN_SUCCESS/);
  });

  it('un echec ne laisse pas de %SEC_LOGIN-4', async () => {
    const { r1, poste } = await laboratoire();
    await echecSsh(poste);

    expect(await r1.executeCommand('show logging')).not.toMatch(/%SEC_LOGIN-4-LOGIN_FAILED/);
  });
});

describe('drapeau arme, la session SUR LE FIL laisse sa ligne', () => {
  it('`login on-success log` : la reussite, dans les mots d\'IOS', async () => {
    const { r1, poste } = await laboratoire('login on-success log');
    await parSsh(poste, CISCO_IP, 'show clock');

    expect(await r1.executeCommand('show logging')).toContain(
      `%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success [user: admin] [Source: ${POSTE_IP}] [localport: 22]\n`);
  });

  it('et UNE ouverture laisse UNE ligne, pas deux', async () => {
    const { r1, poste } = await laboratoire('login on-success log');
    await parSsh(poste, CISCO_IP, 'show clock');

    const log = await r1.executeCommand('show logging');
    expect(log.match(/%SEC_LOGIN-5-LOGIN_SUCCESS/g) ?? []).toHaveLength(1);
  });

  it('`login on-failure log` : l\'echec', async () => {
    const { r1, poste } = await laboratoire('login on-failure log');
    await echecSsh(poste);

    expect(await r1.executeCommand('show logging')).toMatch(
      new RegExp(`%SEC_LOGIN-4-LOGIN_FAILED: Login failed \\[user: admin\\] \\[Source: ${POSTE_IP.replace(/\./g, '\\.')}\\]`));
  });
});

describe('VRP garde la trace de l\'ouverture', () => {
  it('`display logbuffer` porte la session SSH', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, HUAWEI_IP, 'display logbuffer'))
      .toMatch(/SSH2 Session request from 10\.0\.0\.1/);
  });
});
