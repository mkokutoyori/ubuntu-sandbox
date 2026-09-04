/**
 * `execute disconnect-admin-session` coupe une VRAIE session
 * d'administrateur.
 *
 * Mesure de depart : la commande n'existait pas, et il n'y avait AUCUNE
 * table des administrateurs connectes. Mais l'information circulait
 * deja : `FirewallCliServer` appelle `onLogin(user, source)` a chaque
 * ouverture de session SSH ou telnet, et `onLogout(user)` a la
 * fermeture. Le pare-feu recevait ces deux appels et JETAIT le
 * `source` -- `onManagementLogin: (user) => this.management.noteLogin(user)`
 * ne prenait qu'un argument. La provenance etait donc calculee a chaque
 * connexion et perdue au dernier pas.
 *
 * `AdminSessionTable` la retient. Elle est alimentee par le chemin de
 * connexion REEL -- un cas ouvre une session par `ssh admin@<pare-feu>`
 * depuis un poste Linux, sur le vrai serveur SSH du pare-feu, et
 * verifie que la table la porte avec la bonne provenance.
 *
 * Ce que la reference donne, et ou nous divergeons DELIBEREMENT.
 * `official_docs/forti-cli-ref-60.txt` decrit un tableau rendu par
 * `execute disconnect-admin-session ?` :
 *
 *   Connected:
 *   INDEX   USERNAME     TYPE      FROM               TIME
 *   0       admin        WEB       172.20.120.51      Mon Aug 14 ...
 *   1       admin2       CLI       ssh(172.20.120.54) Mon Aug 14 ...
 *
 * Notre `?` rend les MEMES faits -- index, compte, type, provenance --
 * mais dans la forme uniforme a deux colonnes de la coquille, parce que
 * `?` et la tabulation doivent proposer le meme ensemble de mots, regle
 * que ce depot vient d'etablir et de garder par balayage. Un tableau
 * libre sous `?` ferait diverger les deux. La forme `ssh(<ip>)` de la
 * colonne FROM, elle, est reprise telle quelle.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 5 cas
 * tombent -- j'en avais annonce 6, et c'est le compte MESURE qui est
 * ecrit ici. Le seul qui passe des deux cotes est le TEMOIN, dont c'est
 * l'objet : la session SSH s'ouvre vraiment, ce qui a toujours ete vrai
 * et sans quoi la table serait vide pour une raison sans rapport.
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

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lignes: string[]): string {
  let dernier = '';
  for (const ligne of lignes) dernier = sh.execute(ligne);
  return dernier;
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
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
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

const mots = (sh: FortiShell, ligne: string) =>
  sh.help(ligne).map(l => l.trim().split(/\s{2,}/)[0]).filter(w => !w.startsWith('<'));

describe('FortiGate : execute disconnect-admin-session', () => {
  it('TEMOIN : `ssh admin@<pare-feu>` ouvre bien une session', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');
    expect(/FGT\b.*#/.test(host.foreground.getPrompt())).toBe(true);
  });

  it('une VRAIE connexion SSH entre dans la table, avec sa provenance', async () => {
    const { fw, poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    const sessions = fw.getAdminSessions().list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].username).toBe('admin');
    expect(sessions[0].type).toBe('CLI');
    expect(sessions[0].from).toBe('ssh(192.168.1.10)');
  });

  it('la commande COUPE la session nommee', async () => {
    const { fw, sh } = await laboratoire();
    fw.getAdminSessions().open({ username: 'admin', type: 'CLI', transport: 'ssh',
      remote: { ip: '10.0.0.5', port: 40000 } });
    fw.getAdminSessions().open({ username: 'admin2', type: 'WEB', transport: 'web',
      remote: { ip: '10.0.0.6', port: 44300 } });

    expect(sh.execute('execute disconnect-admin-session 0')).toBe('');
    expect(fw.getAdminSessions().list().map(s => s.index)).toEqual([1]);
  });

  it('un index qui ne designe personne est REFUSE', async () => {
    const { sh } = await laboratoire();
    expect(sh.execute('execute disconnect-admin-session 7'))
      .toContain('no administrator session with index 7');
    expect(sh.execute('execute disconnect-admin-session'))
      .toContain('missing');
  });

  it('`?` nomme les sessions VIVANTES et ce qu elles sont', async () => {
    const { fw, sh } = await laboratoire();
    fw.getAdminSessions().open({ username: 'admin', type: 'CLI', transport: 'ssh',
      remote: { ip: '172.20.120.54', port: 40000 } });
    fw.getAdminSessions().open({ username: 'admin2', type: 'WEB', transport: 'web',
      remote: { ip: '172.20.120.51', port: 44300 } });

    const aide = sh.help('execute disconnect-admin-session ');
    expect(aide.find(l => l.startsWith('0')))
      .toContain('admin CLI from ssh(172.20.120.54).');
    expect(aide.find(l => l.startsWith('1')))
      .toContain('admin2 WEB from 172.20.120.51.');
    expect(sh.completions('execute disconnect-admin-session '))
      .toEqual(['execute disconnect-admin-session 0',
        'execute disconnect-admin-session 1']);
  });

  it('l aide SUIT les coupures', async () => {
    const { fw, sh } = await laboratoire();
    fw.getAdminSessions().open({ username: 'admin', type: 'CLI', transport: 'ssh',
      remote: { ip: '10.0.0.5', port: 40000 } });
    fw.getAdminSessions().open({ username: 'admin2', type: 'WEB', transport: 'web',
      remote: { ip: '10.0.0.6', port: 44300 } });
    expect(mots(sh, 'execute disconnect-admin-session ')).toEqual(['0', '1']);

    sh.execute('execute disconnect-admin-session 0');
    expect(mots(sh, 'execute disconnect-admin-session ')).toEqual(['1']);
  });
});
