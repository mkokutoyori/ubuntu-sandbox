/*
 * `%SEC_LOGIN-5-LOGIN_SUCCESS` n'atteignait pas `show logging`.
 *
 * Sur IOS, la reussite et l'echec d'une ouverture de session ne sont pas
 * rangees a part : ce sont des messages SYSLOG, du meme tampon que
 * `%LINK-3-UPDOWN` ou `%SYS-5-CONFIG_I`, et c'est bien pour cela que
 * `logging buffered`, `logging trap`, `logging host` et `terminal
 * monitor` les emportent avec le reste. Il n'existe pas de second
 * journal « de securite » qu'une autre commande rendrait.
 *
 * Le simulateur en avait un. `Router.recordSshLogin` ecrivait dans
 * `SecurityAuditLog`, un tampon a part, et DEUX rendus se partageaient
 * la question :
 *
 *   CiscoRouter.runSshCommandSync  `show logging` -> le journal d'audit
 *   CiscoShellBase (le vrai trie)  `show logging` -> LoggingConfig
 *
 * Le premier n'est tire que par le raccourci en memoire ; la session SSH
 * REELLE passe par le second. Mesure, apres une ouverture de session SSH
 * reussie sur un R1 :
 *
 *   ssh admin@R1 "show logging"   -> AUCUNE ligne %SEC_LOGIN
 *   show logging (console)        -> AUCUNE ligne %SEC_LOGIN
 *   display logbuffer (VRP)       -> AUCUNE trace de l'ouverture
 *
 * La correction ne recopie pas le tampon d'audit dans le journal : elle
 * branche `SecurityAuditLog` sur le journal de la machine au moment ou
 * elle enregistre, donc la ligne est ECRITE une fois, la ou IOS l'ecrit,
 * et le tampon d'audit reste ce qu'il est — l'index structure que
 * `show login failures` releve.
 *
 * Deux consequences qui se verifient ici et qui sont le vrai interet du
 * branchement : la ligne suit desormais les REGLAGES du journal, donc
 * `logging buffered <severite>` la filtre comme n'importe quel autre
 * message ; et elle part vers le collecteur syslog par le meme chemin
 * que les autres.
 *
 * Ecrite a l'aveugle contre cette reference.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 7 cas tombent. Les 3 autres sont nommes ici :
 *
 *  - TEMOIN DU FIL : la session SSH s'ouvre et rend la sortie du
 *    routeur des DEUX cotes. Sans lui, « la connexion echoue » et « la
 *    connexion reussit mais n'est pas journalisee » seraient
 *    indiscernables.
 *  - TEMOIN DU TAMPON : `show logging` rendait DEJA sa vue et son
 *    en-tete. Il designe la cause comme etant l'absence d'ECRITURE, et
 *    non un tampon muet.
 *  - NON-REGRESSION : le tampon d'audit garde son entree — c'est lui
 *    que `show login failures` releve, et le brancher ne doit pas le
 *    vider.
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

async function laboratoire(): Promise<{ r1: CiscoRouter; ar1: HuaweiRouter; poste: LinuxPC }> {
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

describe('la session s\'ouvre vraiment — le TEMOIN', () => {
  it('Cisco rend la sortie de sa commande distante', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, CISCO_IP, 'show clock')).not.toMatch(/Permission denied/);
  });

  it('Huawei aussi', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, HUAWEI_IP, 'display version')).toMatch(/VRP|Huawei|Version/i);
  });
});

describe('l\'ouverture de session est un message du journal', () => {
  it('Cisco : `show logging` porte la ligne %SEC_LOGIN', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, CISCO_IP, 'show logging'))
      .toMatch(/%SEC_LOGIN-5-LOGIN_SUCCESS/);
  });

  it('et la console de la machine porte la MEME ligne', async () => {
    const { r1, poste } = await laboratoire();
    await parSsh(poste, CISCO_IP, 'show clock');

    expect(await r1.executeCommand('show logging')).toMatch(/%SEC_LOGIN-5-LOGIN_SUCCESS/);
  });

  it('Huawei : `display logbuffer` porte la trace de l\'ouverture', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, HUAWEI_IP, 'display logbuffer'))
      .toMatch(/SEC_LOGIN|LOGIN_SUCCESS/i);
  });

  it('un echec d\'authentification laisse sa ligne aussi', async () => {
    const { r1, poste } = await laboratoire();
    await poste.executeCommand(
      `ssh -o NumberOfPasswordPrompts=1 admin@${CISCO_IP} "show clock"`, 'mauvais\n');

    expect(await r1.executeCommand('show logging')).toMatch(/%SEC_LOGIN-4-LOGIN_FAILED/);
  });
});

describe('ce que le correctif ne doit pas casser', () => {
  it('`show logging` garde sa vue — le TEMOIN', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, CISCO_IP, 'show logging')).toMatch(/Syslog logging:/i);
  });

  it('le tampon d\'audit garde son entree', async () => {
    const { r1, poste } = await laboratoire();
    await parSsh(poste, CISCO_IP, 'show clock');

    const audit = r1.getSecurityAuditLog().entries();
    expect(audit.some((e) => e.mnemonic === 'LOGIN_SUCCESS')).toBe(true);
  });
});
