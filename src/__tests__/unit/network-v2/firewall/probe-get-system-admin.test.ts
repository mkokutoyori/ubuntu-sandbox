/**
 * Le pare-feu tenait la table de ses sessions d'administration, et
 * aucune commande ne la MONTRAIT.
 *
 * `AdminSessionTable` existe, elle est alimentee par de vraies
 * connexions SSH et telnet, et son seul lecteur etait `execute
 * disconnect-admin-session` — qui s'en sert pour proposer un index et
 * fermer la session, jamais pour la decrire. `get system admin list` et
 * `get system admin status` sont les deux commandes qui la lisent sur
 * une vraie machine, et les deux repondaient « "list" does not exist » :
 * le mot etait pris pour le NOM d'un compte d'administrateur, la
 * commande de configuration ombrant la vue.
 *
 * **Ce qui manquait n'etait pas seulement la porte, c'etait la
 * matiere.** La sortie attestee par la reference 6.0.4 porte cinq
 * colonnes — `username local device remote started` — ou `device` est
 * `<interface>:<ip>:<port>` du COTE pare-feu et `remote` le
 * `<ip>:<port>` du client. La table n'en gardait qu'une chaine
 * `ssh(10.0.0.5)`, c'est-a-dire le transport et l'adresse, sans aucun
 * port ni interface. Or **ces valeurs existaient et etaient jetees** :
 * `TcpStream` porte `localIp`, `localPort`, `remoteIp`, `remotePort`,
 * et `FirewallCliServer` recevait la connexion complete puis la
 * retrecissait a `{ remoteIp }` par un `as unknown as TcpStream` — un
 * transtypage qui MASQUAIT ce que la socket offrait deja. Cote telnet,
 * le contrat `ITelnetServerContext.openSession(username, fromIp,
 * peerPort)` livrait meme le port du client, et l'implantation du
 * pare-feu le declarait avec deux parametres, donc l'ignorait.
 *
 * `AdminSession` porte desormais le transport, les deux extremites et
 * le domaine virtuel ; `from` en est DERIVE plutot que range a cote,
 * sinon deux ecritures diraient d'ou vient la meme session. Le
 * protocole affiche (`sshv2`, `telnet`, `https`) vient d'une table
 * unique lue par les deux vues.
 *
 * `get system admin status` decrit la session la plus RECENTE, ce
 * qu'une vraie machine appelle « the currently logged in admin » — la
 * commande est tapee DANS une session, et ce simulateur n'attache pas
 * la vue a la session qui l'execute ; le choix est dit ici plutot que
 * laisse a deviner, et il coincide avec la session courante dans le cas
 * qui compte, celui d'un operateur seul.
 *
 * Discrimine par `git stash push -- src/network/` : 6 des 9 cas
 * tombent. Les 3 restants sont nommes ici plutot que laisses a
 * decouvrir, et aucun ne prouve la vue :
 *
 *   - « la connexion SSH est bien reelle » est le TEMOIN, et c'est son
 *     objet de passer des deux cotes : sans lui, une table vide et une
 *     vue absente seraient indiscernables ;
 *   - « le compte d administrateur reste consultable » garde que la vue
 *     n'a pas mange le chemin de configuration `get system admin <nom>` ;
 *   - « la provenance reste derivee du transport et de l adresse » etait
 *     annonce comme discriminant et ne l'est pas : `from` disait deja
 *     `ssh(192.168.1.10)`, et le cas garde seulement que la DERIVER des
 *     nouveaux champs n'a pas change ce qu'elle dit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (device: Cmd, commands: string[]) =>
  commands.reduce(async (p, c) => { await p; await device.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

async function sshLogin(
  host: TerminalSession, ligne: string, motDePasse: string,
): Promise<void> {
  host.setInput(ligne);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(motDePasse);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 10; i++) await tick();
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  poste.powerOn();
  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);

  run(sh, 'config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh', 'next', 'end');
  run(sh, 'config system admin', 'edit "admin"',
    'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end');
  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);
  return { fw, sh, poste };
}

async function connecte(poste: LinuxPC): Promise<void> {
  const host = new LinuxTerminalSession('h', poste);
  await host.init?.();
  await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');
}

describe('get system admin list', () => {
  it('la connexion SSH est bien reelle', async () => {
    const { fw, poste } = await laboratoire();
    await connecte(poste);

    expect(fw.getAdminSessions().list()).toHaveLength(1);
  });

  it('sans session ouverte, seule l en-tete parait', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('get system admin list'))
      .toBe('username local device remote started');
  });

  it('rend les cinq colonnes attestees', async () => {
    const { sh, poste } = await laboratoire();
    await connecte(poste);

    const lignes = sh.execute('get system admin list').split('\n');
    expect(lignes).toHaveLength(2);
    expect(lignes[0].split(/\s+/))
      .toEqual(['username', 'local', 'device', 'remote', 'started']);
  });

  it('nomme le protocole, l interface locale et les deux ports', async () => {
    const { sh, poste } = await laboratoire();
    await connecte(poste);

    const ligne = sh.execute('get system admin list').split('\n')[1];
    expect(ligne).toContain('admin');
    expect(ligne).toContain('sshv2');
    expect(ligne).toContain('port1:192.168.1.1:22');
    expect(ligne).toMatch(/192\.168\.1\.10:\d+/);
  });

  it('le port du client est celui de la vraie connexion', async () => {
    const { fw, poste } = await laboratoire();
    await connecte(poste);

    const session = fw.getAdminSessions().list()[0];
    expect(session.remote.ip).toBe('192.168.1.10');
    expect(session.remote.port).toBeGreaterThan(0);
    expect(session.local).toEqual({ ip: '192.168.1.1', port: 22 });
    expect(session.localInterface).toBe('port1');
  });

  it('la provenance reste derivee du transport et de l adresse', async () => {
    const { fw, poste } = await laboratoire();
    await connecte(poste);

    expect(fw.getAdminSessions().list()[0].from).toBe('ssh(192.168.1.10)');
  });
});

describe('get system admin status', () => {
  it('sans session, la commande le dit au lieu de rendre du vide', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('get system admin status'))
      .toBe('No administrative session is open.');
  });

  it('decrit la session ouverte, ligne par ligne', async () => {
    const { sh, poste } = await laboratoire();
    await connecte(poste);

    const vue = sh.execute('get system admin status');
    expect(vue).toContain('username: admin');
    expect(vue).toContain('login local: sshv2');
    expect(vue).toContain('login device: port1:192.168.1.1:22');
    expect(vue).toContain('login vdom: root');
    expect(vue).toMatch(/login started: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(vue).toMatch(/current time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('le compte d administrateur reste consultable', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('get system admin admin')).toContain('accprofile');
  });
});
