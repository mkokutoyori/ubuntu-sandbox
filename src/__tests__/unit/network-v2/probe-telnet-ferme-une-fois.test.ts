/**
 * Sonde — le mot de la fin d'une session telnet etait ecrit deux fois,
 * et sur un routeur Cisco la session ne se fermait pas du tout.
 *
 * Mesure AVANT (sur `8ab84c34'), depuis un `LinuxPC' :
 *
 *   routeur Cisco, `admin/cisco/show clock/exit/show version' :
 *     R1#show clock
 *     *21:11:39.000 UTC Wed Sep 16 2026
 *     R1#exit
 *     Connection closed.            <- la coquille l'annonce
 *     R1>show version               <- ... et la session continue
 *     Cisco IOS Software, ...
 *   -> zero `Connection closed by foreign host.'
 *
 *   commutateur Cisco, routeur Huawei, commutateur Huawei :
 *     <HW1>quit
 *
 *     Connection closed by foreign host.
 *     Connection closed by foreign host.
 *   -> la ligne DEUX fois
 *
 * DEUX defauts, de part et d'autre du fil.
 *
 * 1. LE SERVEUR ECRIVAIT LE MOT DU CLIENT. `TelnetServerHandler'
 *    poussait `Connection closed by foreign host.' sur le fil a la
 *    fermeture, et le client l'ajoutait de son cote en voyant le pair
 *    fermer : un evenement, deux ecritures. L'autorite est la source du
 *    client telnet BSD -- `telnet/commands.c:2534',
 *    `ExitString("Connection closed by foreign host.\n", 1)' : c'est le
 *    CLIENT qui l'imprime en sortant, jamais le serveur qui l'envoie. Un
 *    telnetd ne dit rien, il ferme. Les cinq sites serveur perdent donc
 *    cette ligne et gardent leurs mots a eux (`% Bad passwords',
 *    `% No free vty lines', `[<raison>]'), que le cas de non-regression
 *    garde.
 *
 * 2. LA COQUILLE DECIDAIT, ET PERSONNE NE LA LISAIT. `fermerSessionExec'
 *    est l'endroit unique ou une session EXEC Cisco se termine : il
 *    remet le niveau de privilege a 1, repasse en mode utilisateur et
 *    rend `Connection closed.'. Les enveloppes de vty
 *    (`Router.createVtyShell', `Switch.createVtyShell') ne le lisaient
 *    pas : elles DEVINAIENT la fin en comparant l'invite avant et apres
 *    -- « un mot de sortie qui laisse l'invite inchangee veut dire qu'il
 *    n'y avait plus de mode a depiler ». La premisse est fausse pour IOS
 *    precisement quand la session se termine depuis l'EXEC privilegie :
 *    la remise a zero du privilege fait passer l'invite de `R1#' a
 *    `R1>', donc l'heuristique conclut « pas fini ». Le commutateur
 *    Cisco n'y echappait que par accident, parce que sa session s'ouvre
 *    en EXEC utilisateur ; les deux coquilles VRP aussi, leur invite
 *    `<HW1>' ne changeant pas sur `quit'.
 *
 *    La coquille repond desormais elle-meme, `execSessionClosed()', et
 *    les quatre implantations la posent la ou la session se termine
 *    vraiment (`fermerSessionExec' cote Cisco, `cmdQuit' en vue
 *    utilisateur cote VRP). L'heuristique disparait.
 *
 * SIX cas sur dix tombent avant la correction (discrimines sur
 * `8ab84c34'). Les QUATRE autres sont NOMMES :
 *
 *   - la session telnet atteint la CLI du routeur : TEMOIN. Il prouve
 *     que le laboratoire, le compte et la ligne vty sont bons, donc
 *     qu'une session qui ne se ferme pas est un signal manquant et non
 *     un laboratoire casse.
 *   - `% Bad passwords' survit : NON-REGRESSION. Elle dit ce que le
 *     point 1 NE retire PAS -- les mots que le serveur a vraiment le
 *     droit de dire restent, seule la ligne du client s'en va.
 *   - `disable' rend la main sans fermer la session : NON-REGRESSION,
 *     et c'est le garde-fou du point 2. Sur IOS `disable' redescend d'un
 *     niveau, `exit' termine ; le nouveau signal doit distinguer les
 *     deux, la ou l'ancienne heuristique les confondait dans l'autre
 *     sens.
 *   - `quit' ferme toujours la session sur un VRP : NON-REGRESSION. Ce
 *     cas-la passait DEJA, mais par accident -- l'invite `<HW1>' ne
 *     change pas. Il est ecrit pour qu'il reste vrai maintenant qu'il
 *     repose sur une decision et non sur une coincidence.
 *
 * LIMITE MESUREE ET NON FERMEE : `fermerSessionExec' rend encore
 * `Connection closed.', que la coquille ecrit sur le fil. Un vrai IOS
 * n'emet rien quand VOTRE session vty se termine -- la ligne appartient
 * a un equipement Cisco agissant en CLIENT telnet, qui affiche
 * `[Connection to X closed by foreign host]'. Rien ici ne permet de
 * trancher le texte exact : cisco.com repond 403 a travers le mandataire
 * de cet environnement et aucune capture de session n'est joignable.
 * Suivant la regle 8, rien n'est devine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const FAREWELL = 'Connection closed by foreign host.';

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

function farewells(transcript: string): number {
  return transcript.split('\n').filter((l) => l.includes(FAREWELL)).length;
}

async function ciscoRouter(): Promise<LinuxPC> {
  const r = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'P1');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  new Cable('c1').connect(pc.getPort('eth0')!, r.getPorts()[0]);
  for (const l of [
    'enable', 'configure terminal', 'hostname R1', 'ip domain-name lab',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret cisco',
    'line vty 0 4', 'login local', 'transport input all', 'exit',
    'crypto key generate rsa modulus 2048', 'end',
  ]) await r.executeCommand(l);
  await settle();
  return pc;
}

async function ciscoSwitch(): Promise<LinuxPC> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'P2');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.1.10'), MASK);
  new Cable('c2').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  for (const l of [
    'enable', 'configure terminal', 'hostname SW1',
    'interface Vlan1', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret cisco',
    'line vty 0 4', 'login local', 'transport input all', 'exit', 'end',
  ]) await sw.executeCommand(l);
  await settle();
  return pc;
}

async function huaweiRouter(): Promise<LinuxPC> {
  const hw = new HuaweiRouter('HW1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'P3');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.2.10'), MASK);
  new Cable('c3').connect(pc.getPort('eth0')!, hw.getPorts()[0]);
  for (const l of [
    'system-view', 'sysname HW1',
    `interface ${hw.getPorts()[0].getName()}`, 'ip address 10.0.2.2 255.255.255.0', 'undo shutdown', 'quit',
    'aaa', 'local-user admin password cipher Admin@123',
    'local-user admin service-type telnet', 'local-user admin privilege level 15', 'quit',
    'telnet server enable',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit', 'quit',
  ]) await hw.executeCommand(l);
  await settle();
  return pc;
}

async function huaweiSwitch(): Promise<LinuxPC> {
  const sw = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'P4');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.3.10'), MASK);
  new Cable('c4').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  for (const l of [
    'system-view', 'sysname HW2',
    'interface Vlanif1', 'ip address 10.0.3.2 255.255.255.0', 'undo shutdown', 'quit',
    'aaa', 'local-user admin password cipher Admin@123',
    'local-user admin service-type telnet', 'local-user admin privilege level 15', 'quit',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit', 'quit',
  ]) await sw.executeCommand(l);
  await settle();
  return pc;
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('une session telnet se ferme une fois, et le mot est celui du client', () => {
  it('temoin : la session telnet atteint bien la CLI du routeur', async () => {
    const pc = await ciscoRouter();
    expect(await pc.executeCommand('telnet 10.0.0.2', 'admin\ncisco\nshow clock\nexit\n'))
      .toMatch(/UTC/);
  }, 30000);

  it('non-regression : les mots du SERVEUR survivent a la correction', async () => {
    const pc = await ciscoRouter();
    expect(await pc.executeCommand('telnet 10.0.0.2', 'admin\nnope\nadmin\nnope\nadmin\nnope\n'))
      .toContain('% Bad passwords');
  }, 30000);

  it('routeur Cisco : `exit` ferme vraiment la session', async () => {
    const pc = await ciscoRouter();
    expect(await pc.executeCommand('telnet 10.0.0.2', 'admin\ncisco\nexit\nshow version\n'))
      .not.toContain('System image file is');
  }, 30000);

  it('routeur Cisco en SSH : `exit` ferme vraiment la session', async () => {
    const pc = await ciscoRouter();
    expect(await pc.executeCommand('ssh admin@10.0.0.2', 'cisco\nexit\nshow version\n'))
      .not.toContain('System image file is');
  }, 30000);

  it('non-regression : `disable` rend la main sans fermer la session', async () => {
    const pc = await ciscoRouter();
    const out = await pc.executeCommand('telnet 10.0.0.2', 'admin\ncisco\ndisable\nshow clock\nexit\n');
    expect(out).toMatch(/UTC/);
    expect(out).toContain('R1>');
  }, 30000);

  it('routeur Cisco : le mot de la fin est ecrit UNE fois', async () => {
    const pc = await ciscoRouter();
    expect(farewells(await pc.executeCommand('telnet 10.0.0.2', 'admin\ncisco\nexit\n'))).toBe(1);
  }, 30000);

  it('commutateur Cisco : le mot de la fin est ecrit UNE fois', async () => {
    const pc = await ciscoSwitch();
    expect(farewells(await pc.executeCommand('telnet 10.0.1.2', 'admin\ncisco\nexit\n'))).toBe(1);
  }, 30000);

  it('routeur Huawei : le mot de la fin est ecrit UNE fois', async () => {
    const pc = await huaweiRouter();
    expect(farewells(await pc.executeCommand('telnet 10.0.2.2', 'admin\nAdmin@123\nquit\n'))).toBe(1);
  }, 30000);

  it('commutateur Huawei : le mot de la fin est ecrit UNE fois', async () => {
    const pc = await huaweiSwitch();
    expect(farewells(await pc.executeCommand('telnet 10.0.3.2', 'admin\nAdmin@123\nquit\n'))).toBe(1);
  }, 30000);

  it('non-regression : `quit` ferme toujours la session sur un VRP', async () => {
    const pc = await huaweiRouter();
    expect(await pc.executeCommand('telnet 10.0.2.2', 'admin\nAdmin@123\nquit\ndisplay version\n'))
      .not.toContain('BOARD TYPE');
  }, 30000);
});
