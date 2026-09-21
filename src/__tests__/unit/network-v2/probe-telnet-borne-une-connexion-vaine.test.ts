/*
 * `telnet` vers une interface qui JETTE tenait la main 63 SECONDES.
 *
 * Mesure de depart, chronometree, vers un FortiGate dont le `port1`
 * porte `set allowaccess ping https` — donc sans telnet, donc le paquet
 * est jete par la politique local-in :
 *
 *   telnet <pare-feu>        (ligne de commande Windows)   63 009 ms
 *   telnet <personne>        (adresse que nul ne porte)    63 010 ms
 *   telnet <port ferme>      (un RST revient)                   3 ms
 *   telnet <pare-feu>        (telnet autorise)                 48 ms
 *
 * Soixante-trois secondes, c'est le repli de retransmission du SYN joue
 * jusqu'au bout. Le simulateur SAIT pourtant des la premiere trame que
 * rien ne reviendra ; il choisit de l'apprendre en attendant.
 *
 * Le depot a DEJA tranche cette question, et pour cette raison exacte.
 * `probe-ssh-une-seule-sonde` l'ecrit noir sur blanc : « un
 * `iptables -j DROP` ne rend JAMAIS la main, faute de delai sur l'appel
 * de connexion. La sonde n'est donc pas du bruit gratuit — elle est le
 * seul chemin qui distingue "ferme" de "filtre" et le seul qui BORNE
 * une connexion qui n'aboutira pas. » `runSshExecAsync` interroge donc
 * le fil avant de composer, et `WindowsPC.cmdSsh` le fait depuis le lot
 * qui a ouvert `ssh` vers un pare-feu. Les deux entrees de `telnet` ne
 * le faisaient pas.
 *
 *   launchTelnet         compose, puis attend le repli
 *   WindowsPC.cmdTelnet  compose, puis attend le repli
 *
 * La premiere sert TOUS les terminaux interactifs — Linux, Windows,
 * IOS, VRP, FortiOS, ASA —, la seconde la ligne de commande Windows.
 * Elles posent desormais la question avant de composer, et ne composent
 * que si le fil a repondu SYN-ACK.
 *
 * LE COUT EST CONNU ET ACCEPTE, c'est le meme que pour `ssh` : une
 * tentative reussie laisse desormais DEUX connexions dans le journal du
 * serveur au lieu d'une, la sonde puis la session. La limite est ecrite
 * dans `probe-ssh-une-seule-sonde`, qui a mesure ce que couterait sa
 * suppression et a garde la sonde.
 *
 * Deuxieme ecriture fermee au passage : `cmdTelnet` composait ses
 * phrases a la main alors que `WINDOWS_TELNET` les porte deja, et que
 * le terminal interactif de la meme machine les lit, lui, dans le
 * dialecte. Deux ecritures d'un meme fait sur une meme machine. Elles
 * passent par `telnetWireFailure`, comme le lot precedent l'a fait pour
 * les autres clients.
 *
 * Ecrite a l'aveugle contre ce qu'un operateur observe : un `telnet`
 * vers un port filtre rend la main, il ne gele pas le terminal. Le
 * discriminant n'est pas une horloge — ce serait fragile — mais le
 * DELAI D'EXPIRATION du cas lui-meme : a cinq secondes, un cas qui
 * attend le repli ne peut pas passer.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network
 * src/terminal`).
 *
 * Les cas qui ne tombent PAS sont nommes : un port FERME rendait deja
 * la main en 3 ms — c'est le TEMOIN qui prouve que le laboratoire sait
 * repondre vite, et sans lui « tout est lent » et « le silence est
 * lent » seraient indiscernables — et une session AUTORISEE doit
 * continuer d'atteindre l'invite, ce qui est le cas qui tombe si l'on
 * « borne » en refusant tout.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const PARE_FEU = '10.0.10.2';
const SERVEUR = '10.0.10.6';
const POSTE_WINDOWS = '10.0.10.8';
const POSTE_LINUX = '10.0.10.9';
const PERSONNE = '10.0.10.77';

/** Un cas qui attend le repli de retransmission ne peut pas tenir ici. */
const BORNE_MS = 5000;

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

interface Cmd { executeCommand(c: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function saisir(s: TerminalSession, ligne: string): Promise<void> {
  s.foreground.setInput(ligne);
  s.foreground.setInputBuf(ligne);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 12; i++) await tick();
}

const transcript = (s: TerminalSession): string => s.lines.map((l) => l.text).join('\n');

async function laboratoire(allowaccess: string) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const pareFeu = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const posteWindows = new WindowsPC('windows-pc', 'WIN', -150, 0);
  const posteLinux = new LinuxPC('linux-pc', 'PC', -150, 150);
  const serveur = new LinuxServer('linux-server', 'SRV', 150, 0);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  commutateur.powerOn(); posteWindows.powerOn(); posteLinux.powerOn(); serveur.powerOn();

  new Cable('a').connect(pareFeu.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(posteWindows.getPorts()[0], commutateur.getPort('eth1')!);
  new Cable('c').connect(posteLinux.getPort('eth0')!, commutateur.getPort('eth2')!);
  new Cable('d').connect(serveur.getPorts()[0], commutateur.getPort('eth3')!);

  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${PARE_FEU} 255.255.255.0`, `set allowaccess ${allowaccess}`, 'next', 'end',
  ]) pareFeu.getShell().execute(ligne);

  const masque = new SubnetMask('255.255.255.0');
  posteWindows.getPorts()[0].configureIP(new IPAddress(POSTE_WINDOWS), masque);
  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR), masque);
  await runOn(serveur, ['ip link set eth0 up']);
  await runOn(posteLinux, ['ip link set eth0 up', `ip addr add ${POSTE_LINUX}/24 dev eth0`]);

  return { pareFeu, posteWindows, posteLinux, serveur };
}

describe('un paquet JETE rend la main', () => {
  it('la ligne de commande Windows', async () => {
    const { posteWindows } = await laboratoire('ping https');

    expect(await posteWindows.executeCommand(`telnet ${PARE_FEU}`))
      .toMatch(/Could not open connection/);
  }, BORNE_MS);

  it('le terminal Windows', async () => {
    const { posteWindows } = await laboratoire('ping https');
    const host = new WindowsTerminalSession('w', posteWindows as never);
    await host.init?.();

    await saisir(host, `telnet ${PARE_FEU}`);

    expect(transcript(host)).toMatch(/Could not open connection/);
  }, BORNE_MS);

  it('le terminal Linux', async () => {
    const { posteLinux } = await laboratoire('ping https');
    const host = new LinuxTerminalSession('l', posteLinux);
    await host.init?.();

    await saisir(host, `telnet ${PARE_FEU}`);

    expect(transcript(host)).toMatch(/Connection timed out/);
  }, BORNE_MS);
});

describe('une adresse que PERSONNE ne porte rend la main aussi', () => {
  it('depuis la ligne de commande Windows', async () => {
    const { posteWindows } = await laboratoire('ping https telnet');

    expect(await posteWindows.executeCommand(`telnet ${PERSONNE}`))
      .toMatch(/Could not open connection/);
  }, BORNE_MS);
});

describe('ce que le correctif ne doit pas casser', () => {
  it('un port FERME rendait DEJA la main — le TEMOIN', async () => {
    const { posteWindows } = await laboratoire('ping https telnet');

    expect(await posteWindows.executeCommand(`telnet ${SERVEUR} 23`))
      .toMatch(/Could not open connection/);
  }, BORNE_MS);

  it('une session AUTORISEE atteint toujours l\'invite', async () => {
    const { posteWindows } = await laboratoire('ping https telnet');

    expect(await posteWindows.executeCommand(`telnet ${PARE_FEU}`))
      .toMatch(/FGT login:/);
  }, BORNE_MS);

  it('et depuis le terminal Windows egalement', async () => {
    const { posteWindows } = await laboratoire('ping https telnet');
    const host = new WindowsTerminalSession('w', posteWindows as never);
    await host.init?.();

    await saisir(host, `telnet ${PARE_FEU}`);

    expect(transcript(host)).toMatch(/Welcome to Microsoft Telnet Client/);
  }, BORNE_MS);
});
