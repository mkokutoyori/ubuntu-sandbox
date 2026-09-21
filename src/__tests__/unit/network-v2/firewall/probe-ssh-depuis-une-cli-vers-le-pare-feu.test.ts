/*
 * Le meme defaut, vu depuis les CLI constructeur.
 *
 * Le lot precedent a rendu au FIL le verdict de `ssh` vers un pare-feu
 * pour les clients Linux et Windows. `CLITerminalSession` — la classe
 * que partagent Cisco IOS, Huawei VRP, FortiOS et ASA — porte la MEME
 * decision, ecrite une quatrieme fois, et elle refuse toujours :
 *
 *   R1# ssh -l admin 10.0.10.2      % Connection refused by remote host
 *   <AR1> stelnet 10.0.10.2         Error: Failed to connect to the remote host.
 *   FGT2 # execute ssh admin@10.0.10.2   (le meme refus)
 *
 *     const sshActive = typeof remote.isSshActive === 'function'
 *       ? remote.isSshActive()
 *       : remote.getSshHost?.()?.isSshActive?.() ?? false;
 *
 * Un pare-feu n'implemente ni l'une ni l'autre, et le `?? false` tranche
 * a sa place. Le port 22 du pare-feu ecoute pourtant, et `nc` le trouve
 * depuis la meme maquette.
 *
 * DEUX ECRITURES D'UN MEME FAIT, et elles avaient deja diverge. La
 * verification des identifiants existe en double —
 * `WindowsTerminalSession.verifyRemoteCredentials` et
 * `CLITerminalSession.verifySshCredentials` — et la seconde ignore le
 * domaine Active Directory que la premiere interroge, ignore le plan de
 * gestion d'un pare-feu, et s'acheve sur le `return true` que le lot
 * precedent vient de fermer dans l'autre. Deux reponses a une question,
 * sans rien pour dire laquelle est juste : les deux se rejoignent ici
 * sur une seule ecriture.
 *
 * La table des messages etait dedoublee de meme. `WIRE_FAILURE_TEXT`
 * rendait les mots d'OpenSSH pour un verdict de fil, `SshDialect`
 * rendait ceux de chaque constructeur pour une cause de panne, et
 * aucune des deux ne savait dire ce que l'autre disait. Une seule table
 * desormais, indexee par le verdict du fil et declinee par
 * constructeur — c'est elle qui permet a IOS de dire
 * « % Connection timed out; remote host not responding » la ou OpenSSH
 * dit « Connection timed out ».
 *
 * Ecrite a l'aveugle contre ce que font les vraies machines :
 *
 *   1. `ssh` depuis un IOS, un VRP ou un FortiOS vers un FortiGate dont
 *      `allowaccess` porte `ssh` atteint l'invite d'administration.
 *   2. Un service absent d'`allowaccess` est JETE, donc chaque
 *      plateforme annonce son SILENCE et non un refus — IOS les
 *      distingue par deux phrases differentes, et c'est la distinction
 *      qui envoie l'operateur vers une regle de filtrage plutot que
 *      vers un service arrete.
 *   3. Un mauvais mot de passe est refuse a l'authentification.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/terminal
 * src/network`) : 4 des 10 cas tombent. Les 6 autres sont nommes ici
 * plutot que laisses a decouvrir, et aucun ne prouve le mecanisme :
 *
 *  - « IOS n'ouvre pas d'invite de mot de passe » passait AVANT parce
 *    que le portail refusait de toute facon. C'est le compagnon du cas
 *    qui tombe : il dit que le SILENCE reste un silence jusqu'au bout,
 *    et non qu'on a remplace un refus trop prompt par une invite qui
 *    n'aboutira pas.
 *  - « un mauvais mot de passe ne pose pas l'operateur sur `FGT #` »
 *    passait pour une raison qui n'est pas la sienne — le portail
 *    tranchait avant toute authentification. Une fois la porte ouverte,
 *    il devient le seul cas qui mesure l'authentification, et il tombe
 *    si l'on ouvre la porte sans brancher le magasin de comptes.
 *  - TEMOINS : un serveur Linux reste joignable depuis une CLI et refuse
 *    le mauvais mot de passe du meme compte ; un routeur Cisco reste
 *    joignable depuis un VRP. Ils portent la surface que le client
 *    savait deja lire, et mesurent ce que le correctif ne doit pas
 *    casser.
 *  - NON-REGRESSION du vrai refus : un demon ARRETE reste
 *    « % Connection refused by remote host ». C'est le cas qui tombe si
 *    l'on supprime le refus au lieu de le faire dependre du fil.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  CiscoTerminalSession, HuaweiTerminalSession, FortiTerminalSession,
} from '@/terminal/sessions';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const PARE_FEU = '10.0.10.2';
const PARE_FEU_2 = '10.0.10.3';
const ROUTEUR = '10.0.10.7';
const VRP = '10.0.10.5';
const SERVEUR = '10.0.10.6';
const SECRET = 'Secret123';

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function saisir(s: TerminalSession, ligne: string): Promise<void> {
  s.foreground.setInput(ligne);
  s.foreground.setInputBuf(ligne);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 14; i++) await tick();
}

async function repondreMotDePasse(s: TerminalSession, secret: string): Promise<void> {
  s.setPasswordBuf(secret);
  s.setInputBuf(secret);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 14; i++) await tick();
}

async function ouvrirSsh(
  s: TerminalSession, ligne: string, secret: string,
): Promise<void> {
  await saisir(s, ligne);
  if (s.currentInputMode.type === 'password') await repondreMotDePasse(s, secret);
}

const transcript = (s: TerminalSession): string => s.lines.map((l) => l.text).join('\n');

const surLePareFeu = (s: TerminalSession): boolean => /FGT\b.*#/.test(s.foreground.getPrompt());

async function demarrer(
  s: TerminalSession & { isBooting?: boolean },
): Promise<TerminalSession> {
  await s.init?.();
  for (let i = 0; i < 60 && s.isBooting; i++) await tick();
  return s;
}

async function laboratoire(allowaccess = 'ping https ssh') {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const pareFeu = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pareFeu2 = new FortiGate('firewall-fortinet', 'FGT2', 0, 300);
  const routeur = new CiscoRouter('R1', 0, 200);
  const vrp = new HuaweiRouter('AR1', 0, 400);
  const serveur = new LinuxServer('linux-server', 'SRV', -150, 0);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  commutateur.powerOn(); routeur.powerOn(); vrp.powerOn(); serveur.powerOn();

  new Cable('a').connect(pareFeu.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(routeur.getPorts()[0], commutateur.getPort('eth1')!);
  new Cable('c').connect(vrp.getPorts()[0], commutateur.getPort('eth2')!);
  new Cable('d').connect(pareFeu2.getPort('port1')!, commutateur.getPort('eth3')!);
  new Cable('e').connect(serveur.getPorts()[0], commutateur.getPort('eth4')!);

  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${PARE_FEU} 255.255.255.0`, `set allowaccess ${allowaccess}`, 'next', 'end',
  ]) pareFeu.getShell().execute(ligne);
  for (const ligne of [
    'config system admin', 'edit "admin"', `set password "${SECRET}"`,
    'set accprofile "super_admin"', 'next', 'end',
  ]) pareFeu.getShell().execute(ligne);

  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${PARE_FEU_2} 255.255.255.0`, 'set allowaccess ping ssh', 'next', 'end',
  ]) pareFeu2.getShell().execute(ligne);
  for (const ligne of [
    'config system admin', 'edit "admin"', `set password "${SECRET}"`,
    'set accprofile "super_admin"', 'next', 'end',
  ]) pareFeu2.getShell().execute(ligne);

  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR), new SubnetMask('255.255.255.0'));
  await runOn(serveur, ['useradd -m alice', `echo alice:${SECRET} | chpasswd`]);

  await runOn(routeur, [
    'enable', 'configure terminal', 'hostname R1',
    `username bob privilege 15 secret ${SECRET}`, 'ip domain-name lab.local',
    'crypto key generate rsa modulus 1024', 'line vty 0 4',
    'transport input ssh', 'login local', 'exit',
    'interface GigabitEthernet0/0', `ip address ${ROUTEUR} 255.255.255.0`,
    'no shutdown', 'end',
  ]);
  await runOn(vrp, [
    'system-view', 'sysname AR1', 'interface GigabitEthernet0/0/0',
    `ip address ${VRP} 255.255.255.0`, 'quit', 'quit',
  ]);

  return { pareFeu, pareFeu2, routeur, vrp, serveur };
}

const surIos = async (r: CiscoRouter): Promise<TerminalSession> => {
  const s = await demarrer(new CiscoTerminalSession('c', r as never));
  await saisir(s, 'enable');
  return s;
};

describe('une CLI constructeur atteint le pare-feu', () => {
  it('depuis un IOS', async () => {
    const { routeur } = await laboratoire();
    const s = await surIos(routeur);

    await ouvrirSsh(s, `ssh -l admin ${PARE_FEU}`, SECRET);

    expect(transcript(s), transcript(s)).not.toMatch(/Connection refused/);
    expect(surLePareFeu(s)).toBe(true);
  });

  it('depuis un VRP', async () => {
    const { vrp } = await laboratoire();
    const s = await demarrer(new HuaweiTerminalSession('h', vrp as never));

    await ouvrirSsh(s, `stelnet ${PARE_FEU}`, SECRET);

    expect(transcript(s), transcript(s)).not.toMatch(/Failed to connect/);
    expect(surLePareFeu(s)).toBe(true);
  });

  it('et depuis un autre FortiOS', async () => {
    const { pareFeu2 } = await laboratoire();
    const s = await demarrer(new FortiTerminalSession('f', pareFeu2 as never));
    await saisir(s, 'admin');
    await repondreMotDePasse(s, SECRET);

    await ouvrirSsh(s, `execute ssh admin@${PARE_FEU}`, SECRET);

    expect(transcript(s), transcript(s)).not.toMatch(/Connection refused/);
  });
});

describe('un paquet JETE reste un silence, dans les mots de chaque CLI', () => {
  it('IOS le distingue de son propre refus', async () => {
    const { routeur } = await laboratoire('ping https');
    const s = await surIos(routeur);

    await saisir(s, `ssh -l admin ${PARE_FEU}`);

    expect(transcript(s)).toMatch(/% Connection timed out; remote host not responding/);
    expect(transcript(s)).not.toMatch(/% Connection refused/);
  });

  it('et n\'ouvre pas d\'invite de mot de passe', async () => {
    const { routeur } = await laboratoire('ping https');
    const s = await surIos(routeur);

    await saisir(s, `ssh -l admin ${PARE_FEU}`);

    expect(s.currentInputMode.type).toBe('normal');
  });
});

describe('l\'authentification n\'est pas dispensee', () => {
  it('un mauvais mot de passe ne pose pas l\'operateur sur `FGT #`', async () => {
    const { routeur } = await laboratoire();
    const s = await surIos(routeur);

    await ouvrirSsh(s, `ssh -l admin ${PARE_FEU}`, 'MAUVAIS');

    expect(surLePareFeu(s), transcript(s)).toBe(false);
  });
});

describe('ce que le correctif ne doit pas casser — les TEMOINS', () => {
  it('une CLI atteint toujours un serveur Linux', async () => {
    const { routeur } = await laboratoire();
    const s = await surIos(routeur);

    await ouvrirSsh(s, `ssh -l alice ${SERVEUR}`, SECRET);

    expect(transcript(s), transcript(s)).not.toMatch(/Connection refused/);
  });

  it('et refuse le mauvais mot de passe de ce meme compte', async () => {
    const { routeur } = await laboratoire();
    const s = await surIos(routeur);

    await ouvrirSsh(s, `ssh -l alice ${SERVEUR}`, 'MAUVAIS');

    expect(transcript(s)).toMatch(/Permission denied|please try again/);
  });

  it('un demon ARRETE reste un vrai refus', async () => {
    const { routeur, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl stop ssh']);
    const s = await surIos(routeur);

    await saisir(s, `ssh -l alice ${SERVEUR}`);

    expect(transcript(s)).toMatch(/% Connection refused by remote host/);
  });

  it('une CLI atteint toujours un autre routeur Cisco', async () => {
    const { vrp } = await laboratoire();
    const s = await demarrer(new HuaweiTerminalSession('h', vrp as never));

    await ouvrirSsh(s, `stelnet ${ROUTEUR}`, SECRET);

    expect(transcript(s), transcript(s)).not.toMatch(/Failed to connect/);
  });
});
