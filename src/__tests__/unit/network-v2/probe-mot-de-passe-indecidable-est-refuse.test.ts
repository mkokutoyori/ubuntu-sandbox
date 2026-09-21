/*
 * Un mot de passe que le simulateur ne sait PAS verifier etait ACCEPTE.
 *
 * `WindowsTerminalSession.verifyRemoteCredentials` interroge tour a
 * tour les magasins de comptes qu'elle sait lire — le domaine, le
 * `checkPassword` d'une machine, le `userMgr` d'un Linux, le plan de
 * gestion d'un pare-feu, l'evaluateur AAA d'un routeur — et, quand
 * aucun ne repond, s'achevait sur :
 *
 *     return true;
 *
 * C'est l'inverse de la regle que ce depot tient partout ailleurs : un
 * critere de securite que le moteur ne sait pas trancher doit faire
 * ECHOUER l'entree, jamais la laisser passer. Ecrit ainsi, tout pair
 * dont le client ne reconnait pas le magasin ouvrait une session
 * d'administration avec n'importe quelle chaine de caracteres.
 *
 * CE QUE CE CAS EST, ET CE QU'IL N'EST PAS. Aucun equipement livre
 * aujourd'hui ne tombe dans cette branche : un Linux et un Windows
 * portent `checkPassword`, un routeur et un commutateur portent
 * `getSshHost`, un pare-feu porte `authenticateAdmin` depuis le lot qui
 * a ouvert `ssh` vers lui. La branche est donc le DEFAUT dont herite la
 * prochaine classe d'equipement — et c'est bien ce defaut qui vient de
 * se faire mesurer sur le pare-feu, ou le portail refusait avant toute
 * authentification et masquait l'acceptation inconditionnelle derriere
 * lui. Le laboratoire modelise donc exactement cela : un pair joignable,
 * dont le demon repond, et dont le magasin de comptes est hors de
 * portee du client.
 *
 * Ecrite a l'aveugle contre ce que fait un vrai serveur SSH : il ne
 * connait que deux reponses, `Accepted` et `Failed`, et l'absence de
 * base de comptes se dit `Failed`, jamais `Accepted`.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/terminal`) :
 * 1 des 5 cas tombe. Les 4 autres sont les TEMOINS sans lesquels
 * « refuser l'indecidable » et « refuser tout le monde » seraient
 * indiscernables : un compte Linux reel accepte son mot de passe et
 * refuse un autre, et un administrateur de pare-feu de meme. Ils
 * passent des deux cotes, et c'est leur objet.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const PARE_FEU = '10.0.30.2';
const SERVEUR = '10.0.30.6';
const POSTE = '10.0.30.8';
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

const resteLocal = (h: TerminalSession): boolean => /^C:\\/.test(h.foreground.getPrompt());

/** Un pair joignable dont le magasin de comptes est hors de portee. */
function masquerLeMagasin(peer: object): void {
  for (const nom of ['checkPassword', 'userMgr', 'tryDomainAuth', 'getSshHost']) {
    Object.defineProperty(peer, nom, { value: undefined, configurable: true });
  }
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const pareFeu = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const shell = pareFeu.getShell();
  const serveur = new LinuxServer('linux-server', 'SRV', -150, 0);
  const poste = new WindowsPC('windows-pc', 'WIN', -150, 100);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  serveur.powerOn(); poste.powerOn(); commutateur.powerOn();

  new Cable('a').connect(serveur.getPorts()[0], commutateur.getPort('eth0')!);
  new Cable('b').connect(pareFeu.getPort('port1')!, commutateur.getPort('eth1')!);
  new Cable('c').connect(poste.getPorts()[0], commutateur.getPort('eth2')!);

  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${PARE_FEU} 255.255.255.0`, 'set allowaccess ping https ssh', 'next', 'end',
  ]) shell.execute(ligne);
  for (const ligne of [
    'config system admin', 'edit "admin"', `set password "${SECRET}"`,
    'set accprofile "super_admin"', 'next', 'end',
  ]) shell.execute(ligne);

  const masque = new SubnetMask('255.255.255.0');
  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR), masque);
  poste.getPorts()[0].configureIP(new IPAddress(POSTE), masque);
  await runOn(serveur, [`useradd -m alice`, `echo alice:${SECRET} | chpasswd`]);

  const terminal = new WindowsTerminalSession('w', poste as never);
  await terminal.init?.();

  return { pareFeu, serveur, poste, terminal };
}

describe('un magasin de comptes hors de portee REFUSE', () => {
  it('n\'importe quelle chaine n\'ouvre pas de session', async () => {
    const { serveur, terminal } = await laboratoire();
    masquerLeMagasin(serveur);

    await ouvrirSsh(terminal, `ssh alice@${SERVEUR}`, 'nimporte-quoi');

    expect(transcript(terminal)).toMatch(/Permission denied/);
    expect(resteLocal(terminal), transcript(terminal)).toBe(true);
  });
});

describe('les magasins que le client sait lire tranchent toujours — les TEMOINS', () => {
  it('un compte Linux accepte SON mot de passe', async () => {
    const { terminal } = await laboratoire();

    await ouvrirSsh(terminal, `ssh alice@${SERVEUR}`, SECRET);

    expect(transcript(terminal)).not.toMatch(/Permission denied/);
    expect(resteLocal(terminal)).toBe(false);
  });

  it('et refuse un autre', async () => {
    const { terminal } = await laboratoire();

    await ouvrirSsh(terminal, `ssh alice@${SERVEUR}`, 'MAUVAIS');

    expect(resteLocal(terminal), transcript(terminal)).toBe(true);
  });

  it('un administrateur de pare-feu accepte SON mot de passe', async () => {
    const { terminal } = await laboratoire();

    await ouvrirSsh(terminal, `ssh admin@${PARE_FEU}`, SECRET);

    expect(resteLocal(terminal), transcript(terminal)).toBe(false);
  });

  it('et refuse un autre', async () => {
    const { terminal } = await laboratoire();

    await ouvrirSsh(terminal, `ssh admin@${PARE_FEU}`, 'MAUVAIS');

    expect(resteLocal(terminal), transcript(terminal)).toBe(true);
  });
});
