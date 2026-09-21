/*
 * « Pourquoi est-ce que je n'arrive pas a me connecter en ssh au
 * pare-feu ? » — le `ping` passe, `allowaccess` porte `ssh`, et le
 * client repond `Connection refused`.
 *
 * La mesure de depart pose la meme question a QUATRE vues de la MEME
 * machine, au meme instant, sur un FortiGate en 10.0.10.2 dont le
 * `port1` porte `set allowaccess ping https ssh` :
 *
 *   nc -zv 10.0.10.2 22            Connection ... succeeded!
 *   ssh admin@10.0.10.2  (terminal Linux)   FGT #
 *   sshpass ... ssh admin@10.0.10.2 "get system status"   la reponse
 *   ssh admin@10.0.10.2  (terminal Windows) Connection refused
 *   ssh admin@10.0.10.2  (executeCommand)   Connection refused
 *
 * Le fil dit OUVERT, et deux clients disent FERME. Le pare-feu heberge
 * pourtant un vrai serveur SSH — `FirewallCliServer` pose un ecouteur
 * sur le port 22 de sa `TcpStack`, et c'est lui que `nc` et le terminal
 * Linux atteignent.
 *
 * La cause n'est pas dans le pare-feu : elle est dans les clients. Trois
 * d'entre eux tranchent « ce pair sert-il SSH ? » en interrogeant
 * l'OBJET du pair, et refusent des qu'ils n'y reconnaissent pas une
 * surface connue :
 *
 *   LinuxSshClient        `typeof machine.isServiceActive !== 'function'`
 *   WindowsSshClient      `typeof machine.isSshActive !== 'function'`
 *   WindowsTerminalSession `remote.isSshActive?.() ?? ... ?? false`
 *
 * Un `Firewall` etend `Equipment` et non `Router` : il n'implemente
 * aucune des trois, donc les trois le declarent ferme. Le verdict du
 * FIL, lui, est calcule, transmis (`SshClientOpts.wireOutcome`) et jete
 * sans etre lu, parce que le refus tombe en amont.
 *
 * Le depot a deja tranche la question de l'autorite, et ce lot ne fait
 * que l'appliquer un cran plus loin : « ce que le client annonce est ce
 * que le FIL lui a repondu » (probe-ssh-verdict-lit-l-icmp-du-fil). Un
 * pair qui repond SYN-ACK SERT, que le client sache nommer sa classe ou
 * non ; la seule chose qu'il ne sait pas encore est s'il sera AUTORISE,
 * et cela se dit `Permission denied`, pas `Connection refused`.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate, verifie
 * contre la documentation Fortinet :
 *
 *   1. `set allowaccess ... ssh` ouvre l'acces admin en SSH sur cette
 *      interface, depuis n'importe quel client — la plateforme du client
 *      ne rentre pas dans la decision.
 *   2. Un service ABSENT de `allowaccess` est JETE par la politique
 *      local-in implicite : le client n'obtient pas un refus, il
 *      n'obtient RIEN, donc `Connection timed out` et jamais
 *      `Connection refused`. C'est la distinction que
 *      `ssh-refus-contre-silence` a etablie pour le terminal Linux et
 *      que les autres chemins ne tenaient pas.
 *   3. Un mauvais mot de passe est refuse a l'AUTHENTIFICATION —
 *      `Permission denied` — et ne pose pas l'operateur sur l'invite
 *      `FGT #`.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network
 * src/terminal`) : 7 des 17 cas tombent. Les 10 autres sont nommes ici
 * plutot que laisses a decouvrir, et aucun ne prouve le mecanisme :
 *
 *  - TEMOINS DU FIL, et c'est tout leur objet : `nc` trouve le port 22
 *    ouvert, le terminal Linux atteint `FGT #`, et `sshpass ... "get
 *    system status"` rapporte la reponse du pare-feu. Ils passent des
 *    DEUX cotes — sans eux, « le pare-feu ne sert pas SSH » et « les
 *    clients se trompent » seraient indiscernables, et c'est eux qui
 *    designent le defaut comme etant cote CLIENT.
 *  - TEMOIN DU SILENCE : sans `ssh` dans `allowaccess`, `nc` disait deja
 *    `Connection timed out`. C'est la vue JUSTE dont les autres
 *    divergeaient.
 *  - « un mauvais mot de passe ne pose pas l'operateur sur `FGT #` »
 *    passait AVANT pour une raison qui n'est pas la sienne : le portail
 *    refusait avant toute authentification, donc le mot de passe
 *    n'etait jamais lu. Une fois le portail ouvert, il devient le seul
 *    cas qui mesure l'authentification elle-meme — et il tombait si le
 *    correctif s'arretait a ouvrir la porte, car la verification des
 *    identifiants du terminal Windows s'achevait sur un `return true`
 *    pour tout pair dont elle ne reconnait pas le magasin de comptes.
 *  - NON-REGRESSIONS d'autres constructeurs : un routeur Cisco reste
 *    joignable en `ssh` depuis Linux et depuis Windows, sur les deux
 *    chemins. Ils passent des deux cotes parce que le routeur, lui,
 *    porte la surface que les clients savent lire — ils mesurent ce que
 *    le correctif ne doit pas casser.
 *  - NON-REGRESSIONS du vrai refus : un demon arrete sur une machine
 *    joignable doit RESTER `Connection refused`, sur les deux chemins.
 *    C'est le cas qui tombe si l'on « corrige » en supprimant le refus
 *    au lieu de le faire dependre du fil.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const PARE_FEU = '10.0.10.2';
const ROUTEUR = '10.0.10.7';
const SERVEUR = '10.0.10.6';
const POSTE_LINUX = '10.0.10.9';
const POSTE_WINDOWS = '10.0.10.8';
const SECRET = 'Secret123';

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function ouvrirSsh(
  host: TerminalSession, ligne: string, motDePasse: string,
): Promise<void> {
  host.setInput(ligne);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 14 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(motDePasse);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 14; i++) await tick();
}

const transcript = (h: TerminalSession): string => h.lines.map((l) => l.text).join('\n');

const surLePareFeu = (h: TerminalSession): boolean => /FGT\b.*#/.test(h.foreground.getPrompt());

async function laboratoire(allowaccess = 'ping https ssh') {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const pareFeu = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const shell = pareFeu.getShell();
  const routeur = new CiscoRouter('R1', 0, 200);
  const posteLinux = new LinuxPC('linux-pc', 'PC', -150, 0);
  const posteWindows = new WindowsPC('windows-pc', 'WIN', -150, 100);
  const serveur = new LinuxServer('linux-server', 'SRV', -150, 200);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  posteLinux.powerOn(); posteWindows.powerOn(); serveur.powerOn();
  commutateur.powerOn(); routeur.powerOn();

  new Cable('a').connect(posteLinux.getPort('eth0')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(pareFeu.getPort('port1')!, commutateur.getPort('eth1')!);
  new Cable('c').connect(posteWindows.getPorts()[0], commutateur.getPort('eth2')!);
  new Cable('d').connect(routeur.getPorts()[0], commutateur.getPort('eth3')!);
  new Cable('e').connect(serveur.getPorts()[0], commutateur.getPort('eth4')!);

  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${PARE_FEU} 255.255.255.0`, `set allowaccess ${allowaccess}`, 'next', 'end',
  ]) shell.execute(ligne);
  for (const ligne of [
    'config system admin', 'edit "admin"', `set password "${SECRET}"`,
    'set accprofile "super_admin"', 'next', 'end',
  ]) shell.execute(ligne);

  const masque = new SubnetMask('255.255.255.0');
  await runOn(posteLinux, ['ip link set eth0 up', `ip addr add ${POSTE_LINUX}/24 dev eth0`]);
  posteWindows.getPorts()[0].configureIP(new IPAddress(POSTE_WINDOWS), masque);
  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR), masque);

  await runOn(routeur, [
    'enable', 'configure terminal', 'hostname R1',
    `username bob privilege 15 secret ${SECRET}`, 'ip domain-name lab.local',
    'crypto key generate rsa modulus 1024', 'line vty 0 4',
    'transport input ssh', 'login local', 'exit',
    'interface GigabitEthernet0/0', `ip address ${ROUTEUR} 255.255.255.0`,
    'no shutdown', 'end',
  ]);

  return { pareFeu, shell, routeur, posteLinux, posteWindows, serveur };
}

describe('le fil dit que le pare-feu sert SSH — les TEMOINS', () => {
  it('`nc` trouve le port 22 ouvert', async () => {
    const { posteLinux } = await laboratoire();

    expect(await posteLinux.executeCommand(`nc -zv ${PARE_FEU} 22`)).toMatch(/succeeded/);
  });

  it('le terminal Linux atteint l\'invite du pare-feu', async () => {
    const { posteLinux } = await laboratoire();
    const host = new LinuxTerminalSession('h', posteLinux);
    await host.init?.();

    await ouvrirSsh(host, `ssh admin@${PARE_FEU}`, SECRET);

    expect(surLePareFeu(host)).toBe(true);
  });

  it('une commande distante rapporte la reponse du pare-feu', async () => {
    const { posteLinux } = await laboratoire();

    const sortie = await posteLinux.executeCommand(
      `sshpass -p ${SECRET} ssh admin@${PARE_FEU} "get system status"`);

    expect(sortie).toMatch(/Hostname: FGT/);
  });
});

describe('les clients cessent de contredire le fil', () => {
  it('le terminal Windows atteint l\'invite du pare-feu', async () => {
    const { posteWindows } = await laboratoire();
    const host = new WindowsTerminalSession('w', posteWindows as never);
    await host.init?.();

    await ouvrirSsh(host, `ssh admin@${PARE_FEU}`, SECRET);

    expect(transcript(host), transcript(host)).not.toMatch(/Connection refused/);
    expect(surLePareFeu(host)).toBe(true);
  });

  it('`ssh` depuis la ligne de commande Windows ne refuse plus', async () => {
    const { posteWindows } = await laboratoire();

    const sortie = await posteWindows.executeCommand(`ssh admin@${PARE_FEU}`);

    expect(sortie).not.toMatch(/Connection refused/);
  });

  it('sans mot de passe, Linux repond Permission denied et non un refus', async () => {
    const { posteLinux } = await laboratoire();

    const sortie = await posteLinux.executeCommand(`ssh admin@${PARE_FEU}`);

    expect(sortie).not.toMatch(/Connection refused/);
    expect(sortie).toMatch(/Permission denied/);
  });

  it('avec un mauvais mot de passe aussi', async () => {
    const { posteLinux } = await laboratoire();

    const sortie = await posteLinux.executeCommand(
      `sshpass -p FAUX ssh admin@${PARE_FEU} "get system status"`);

    expect(sortie).not.toMatch(/Connection refused/);
    expect(sortie).toMatch(/Permission denied/);
  });
});

describe('un paquet JETE reste un silence, pas un refus', () => {
  it('`nc` le dit deja — le TEMOIN', async () => {
    const { posteLinux } = await laboratoire('ping https');

    expect(await posteLinux.executeCommand(`nc -zv -w 1 ${PARE_FEU} 22`))
      .toMatch(/timed out/);
  });

  it('`ssh` depuis Linux le dit comme `nc`', async () => {
    const { posteLinux } = await laboratoire('ping https');

    const sortie = await posteLinux.executeCommand(
      `sshpass -p ${SECRET} ssh admin@${PARE_FEU} "get system status"`);

    expect(sortie).toMatch(/Connection timed out/);
    expect(sortie).not.toMatch(/Connection refused/);
  });

  it('`ssh` depuis la ligne de commande Windows aussi', async () => {
    const { posteWindows } = await laboratoire('ping https');

    const sortie = await posteWindows.executeCommand(`ssh admin@${PARE_FEU}`);

    expect(sortie).toMatch(/Connection timed out/);
    expect(sortie).not.toMatch(/Connection refused/);
  });

  it('et le terminal Windows ne demande meme pas de mot de passe', async () => {
    const { posteWindows } = await laboratoire('ping https');
    const host = new WindowsTerminalSession('w', posteWindows as never);
    await host.init?.();

    await ouvrirSsh(host, `ssh admin@${PARE_FEU}`, SECRET);

    expect(transcript(host)).toMatch(/Connection timed out/);
    expect(surLePareFeu(host)).toBe(false);
  });
});

describe('l\'authentification n\'est pas dispensee', () => {
  it('un mauvais mot de passe ne pose pas l\'operateur sur `FGT #`', async () => {
    const { posteWindows } = await laboratoire();
    const host = new WindowsTerminalSession('w', posteWindows as never);
    await host.init?.();

    await ouvrirSsh(host, `ssh admin@${PARE_FEU}`, 'MAUVAIS');

    expect(surLePareFeu(host), transcript(host)).toBe(false);
  });
});

describe('ce que le correctif ne doit pas casser — les NON-REGRESSIONS', () => {
  it('un routeur Cisco reste joignable depuis Linux', async () => {
    const { posteLinux } = await laboratoire();

    expect(await posteLinux.executeCommand(
      `sshpass -p ${SECRET} ssh bob@${ROUTEUR} "show version"`))
      .toMatch(/Cisco IOS Software/);
  });

  it('un routeur Cisco reste joignable depuis Windows', async () => {
    const { posteWindows } = await laboratoire();

    expect(await posteWindows.executeCommand(`ssh bob@${ROUTEUR}`))
      .toMatch(/R1#/);
  });

  it('un routeur Cisco reste joignable depuis le terminal Windows', async () => {
    const { posteWindows } = await laboratoire();
    const host = new WindowsTerminalSession('w', posteWindows as never);
    await host.init?.();

    await ouvrirSsh(host, `ssh bob@${ROUTEUR}`, SECRET);

    expect(transcript(host)).not.toMatch(/Connection refused/);
  });

  it('un demon ARRETE sur une machine joignable reste un vrai refus', async () => {
    const { posteLinux, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl stop ssh']);

    expect(await posteLinux.executeCommand(`ssh alice@${SERVEUR}`))
      .toMatch(/Connection refused/);
  });

  it('et depuis le terminal Windows egalement', async () => {
    const { posteWindows, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl stop ssh']);
    const host = new WindowsTerminalSession('w', posteWindows as never);
    await host.init?.();

    await ouvrirSsh(host, `ssh alice@${SERVEUR}`, SECRET);

    expect(transcript(host)).toMatch(/Connection refused/);
  });
});
