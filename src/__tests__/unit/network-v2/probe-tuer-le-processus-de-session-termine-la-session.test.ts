/**
 * Tuer le processus qui tient une session sshd termine la session : `who`, `loginctl`, `ps`, `auth.log` et le client
 * disent tous la meme chose, au lieu de laisser un enregistrement sans processus ni connexion.
 *
 * Mesure de depart (ac239fdd9 = 608f58462 + les deux lots des processus ssh) : PC1 tient un tunnel
 * `ssh -f -N -L 9003:10.0.0.3:8080 user@10.0.0.2` sur PC2, puis `sudo kill` du shell que porte le moniteur
 * `sshd: user [priv]`. Le shell sortait de `ps` et rien d'autre ne bougeait : `who` listait toujours `user pts/0`,
 * `loginctl list-sessions` la session 41, le moniteur restait, la connexion restait ESTAB des deux cotes, le `ssh`
 * du client gardait son ecoute sur 9003 et `auth.log` n'avait aucune ligne `Removed session`. Tuer le moniteur
 * terminait pourtant la session, mais par hasard : le faucheur de prises detruisait la prise sans rien emettre, et
 * cette destruction prevenait l'application du serveur sans jamais prevenir le client. Fermer la prise comme le fait
 * `tcp_close()` (FIN ou RST, lot de fermeture ordinaire) ne previent l'application qu'a la destruction de la prise ;
 * sans la correction ci-dessous, un moniteur tue ne fermait donc plus rien, et `loginctl terminate-session` non plus :
 * son action cote executeur est une copie plus pauvre de celle de la machine (ni noeud `pts`, ni session logind, ni
 * lignes de journal).
 *
 * Autorites : OpenSSH 8.9p1, `monitor.c` lignes 379 a 393 : le moniteur renvoie SIGHUP, SIGTERM et SIGINT a son
 * enfant sans privilege et continue de tourner ; `monitor_wrap.c` lignes 149 a 151 : la lecture du moniteur qui voit
 * le canal se fermer appelle `cleanup_exit(255)`, et `session.c` `do_cleanup` (ligne 2642) ferme alors la session PAM
 * (`sshpam_cleanup`) : un SIGTERM sur le moniteur donne donc UNE ligne `pam_unix(sshd:session): session closed` et la
 * fin de la connexion. systemd 249 (Ubuntu 22.04), `man/loginctl.xml` : `terminate-session` « kills all processes of
 * the session and deallocates all resources attached to the session ».
 *
 * Ce qui est construit : `LinuxMachine.endSshSession`, l'UNIQUE chemin qui termine une session (enregistrement,
 * noeud `pts`, session logind, lignes `logged out` / `Removed session`, ligne de la table des sockets, processus),
 * pris par la sortie ordinaire, par `loginctl terminate-session` / `kill-session` / `terminate-user` et par la sortie
 * d'un processus de la session (abonnement a `linux.process.exited` : `kill`, `pkill`, `killall`). L'action
 * `loginctl` n'existe plus qu'une fois : l'executeur recoit celle de la machine (`setLoginctlAction`), et la
 * correspondance identifiant -> session est celle du formateur (`loginctlSessionId`), non plus trois copies. Cote
 * client, `SshSession.onDisconnected` et `SshForwardingTable.adopt` : une connexion perdue retire les redirections de
 * la session et fait sortir le processus `ssh` qui la tenait (jusque-la seule la sortie du processus fermait la
 * connexion, jamais l'inverse). Cote pile, `closeSocketsOwnedBy` previent l'application de la fermeture de sa prise
 * (`_fireClose`, une seule fois) : un demon dont le processus sort apprend que sa connexion est finie, au lieu de
 * l'apprendre a la destruction de la prise.
 *
 * Ce qui n'est PAS construit : un moniteur tue par SIGKILL n'ecrirait aucune ligne PAM dans un vrai sshd (rien ne
 * s'execute plus pour le faire) ; ici la ligne est ecrite comme pour SIGTERM, le gestionnaire de la connexion etant le
 * meme objet pour les deux. Une session telnet n'a pas de processus propre (elle porte le pid de telnetd) : sa fin
 * reste celle de sa connexion.
 *
 * Discrimination, mesuree en DEUX temps. Contre ac239fdd9 (`git stash` de `src/network`, sonde copiee) : DEUX cas
 * sur neuf tombent, « le client entend » et « tuer le shell du moniteur termine la session » ; les sept autres
 * passent des deux cotes, dont un TEMOIN (un tunnel en cours est UNE session pour `who`, `loginctl` et `ps`, avec sa
 * ligne dans `auth.log` : sans lui, une sonde d'absences passerait sur un laboratoire casse) et six NON-REGRESSIONS
 * de ce que le silence de l'ancien faucheur donnait par accident. Contre ac239fdd9 + le seul lot de fermeture
 * ordinaire, ou ces six deviennent des defauts : SEPT cas sur neuf tombent, le temoin et « le demon sshd n'est pas
 * une session » passant des deux cotes. Mutations de la correction, chacune tuee : ne pas s'abonner a la sortie des
 * processus fait tomber 1 cas ; ne pas injecter l'action dans l'executeur en fait tomber 1 ; ne pas ecouter la perte
 * de connexion cote client en fait tomber 1 ; ne pas arreter les processus a la fin de la session en fait tomber 2 ;
 * ne pas ecrire les lignes de fin en fait tomber 2 ; ne pas prevenir l'application a la sortie du processus en fait
 * tomber 3 ; terminer la premiere session de l'utilisateur quel que soit le processus qui sort en fait tomber 6 ;
 * apparier les sessions en cherchant le pid dans la table, telnetd compris, en fait tomber 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { TelnetClientSession, type TelnetClientTransport } from '@/network/protocols/telnet/TelnetClientSession';
import { buildLan, assignIps, PC2_IP, PC3_IP, type SshLan } from './ssh-lan-fixtures';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly user: string;
  readonly tty: string;
  readonly comm: string;
  readonly args: string;
}

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
});

async function processes(machine: LinuxPC): Promise<ProcessRow[]> {
  const listing = await machine.executeCommand('ps -eo pid,ppid,user,tty,comm,args');
  return listing.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    return match === null
      ? []
      : [{ pid: Number(match[1]), ppid: Number(match[2]), user: match[3], tty: match[4], comm: match[5], args: match[6] }];
  });
}

async function sessionProcesses(machine: LinuxPC, user = 'user'): Promise<ProcessRow[]> {
  const all = await processes(machine);
  const monitors = all.filter((row) => row.args === `sshd: ${user} [priv]`);
  const shells = all.filter((row) => row.comm === '-bash' && monitors.some((monitor) => monitor.pid === row.ppid));
  return [...monitors, ...shells];
}

async function telnetSession(): Promise<void> {
  await lan.pc2.executeCommand('sudo systemctl start telnet');
  const socket = await (lan.pc1 as unknown as {
    tcpConnect(host: string, port: number): Promise<TelnetClientTransport | null>;
  }).tcpConnect(PC2_IP, 23);
  const session = new TelnetClientSession(socket!);
  await settle();
  session.send('user');
  await settle();
  session.send('admin');
  await settle();
}

async function tunnel(): Promise<void> {
  await lan.pc1.executeCommand(`ssh -f -N -L 9003:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
}

async function who(machine: LinuxPC): Promise<string> {
  return (await machine.executeCommand('who')).split('\n').filter((line) => line.includes('pts/')).join('\n');
}

async function authLines(machine: LinuxPC, pattern: RegExp): Promise<number> {
  const log = await machine.executeCommand('sudo cat /var/log/auth.log');
  return log.split('\n').filter((line) => pattern.test(line)).length;
}

const closedLines = (machine: LinuxPC) => authLines(machine, /Removed session \d+\./);
const pamClosedLines = (machine: LinuxPC) => authLines(machine, /pam_unix\(sshd:session\): session closed for user user/);

async function sessionId(machine: LinuxPC): Promise<string> {
  const listing = await machine.executeCommand('loginctl list-sessions');
  return listing.split('\n').find((line) => /\bpts\//.test(line))?.trim().split(/\s+/)[0] ?? '';
}

describe('the bench is sound (witnesses)', () => {
  it('a tunnel in progress is one session for who, loginctl and ps, with a session line in auth.log', async () => {
    await tunnel();
    expect(await who(lan.pc2)).toContain('user');
    expect(await sessionId(lan.pc2)).toMatch(/^\d+$/);
    expect(await sessionProcesses(lan.pc2)).toHaveLength(2);
    expect(await closedLines(lan.pc2)).toBe(0);
    expect(await pamClosedLines(lan.pc2)).toBe(0);
  });
});

describe('killing the process that holds a session ends the session', () => {
  it('kill of the monitor: who, loginctl and ps all say nobody, and the shell it carried is gone', async () => {
    await tunnel();
    const [monitor] = await sessionProcesses(lan.pc2);
    await lan.pc2.executeCommand(`sudo kill ${monitor.pid}`);
    await settle();
    expect(await who(lan.pc2)).toBe('');
    expect(await sessionId(lan.pc2)).toBe('');
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
  });

  it('the session is closed once in auth.log, not zero times and not twice: logind removes it and sshd closes its PAM session', async () => {
    await tunnel();
    const [monitor] = await sessionProcesses(lan.pc2);
    await lan.pc2.executeCommand(`sudo kill ${monitor.pid}`);
    await settle();
    expect(await closedLines(lan.pc2)).toBe(1);
    expect(await pamClosedLines(lan.pc2)).toBe(1);
  });

  it('the client hears it: its tunnel process retires and its listener closes', async () => {
    await tunnel();
    const [monitor] = await sessionProcesses(lan.pc2);
    expect((await processes(lan.pc1)).filter((row) => row.comm === 'ssh')).toHaveLength(1);
    await lan.pc2.executeCommand(`sudo kill ${monitor.pid}`);
    await settle();
    expect((await processes(lan.pc1)).filter((row) => row.comm === 'ssh')).toEqual([]);
    expect(await lan.pc1.executeCommand('ss -tln sport = :9003')).not.toContain('9003');
  });

  it('kill of the shell the monitor carries ends the session too', async () => {
    await tunnel();
    const shell = (await sessionProcesses(lan.pc2)).find((row) => row.comm === '-bash')!;
    await lan.pc2.executeCommand(`sudo kill ${shell.pid}`);
    await settle();
    expect(await who(lan.pc2)).toBe('');
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
  });

  it('loginctl terminate-session still ends it, once, with the same views', async () => {
    await tunnel();
    const id = await sessionId(lan.pc2);
    await lan.pc2.executeCommand(`sudo loginctl terminate-session ${id}`);
    await settle();
    expect(await who(lan.pc2)).toBe('');
    expect(await sessionId(lan.pc2)).toBe('');
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
    expect(await closedLines(lan.pc2)).toBe(1);
    expect(await pamClosedLines(lan.pc2)).toBe(1);
  });

  it('another session of the same user is left alone', async () => {
    await tunnel();
    await lan.pc1.executeCommand(`ssh -f -N -L 9004:${PC3_IP}:8081 user@${PC2_IP}`, 'admin\n');
    const monitors = (await sessionProcesses(lan.pc2)).filter((row) => row.comm === 'sshd');
    expect(monitors).toHaveLength(2);
    await lan.pc2.executeCommand(`sudo kill ${monitors[0].pid}`);
    await settle();
    const left = await sessionProcesses(lan.pc2);
    expect(left.filter((row) => row.comm === 'sshd').map((row) => row.pid)).toEqual([monitors[1].pid]);
    expect(await who(lan.pc2).then((text) => text.split('\n').filter(Boolean))).toHaveLength(1);
    expect(await lan.pc1.executeCommand('ss -tln sport = :9004')).toContain('9004');
  });

  it('the sshd daemon is not a session: killing it leaves an established session alone', async () => {
    await tunnel();
    const daemon = (await processes(lan.pc2)).find((row) => row.comm === 'sshd' && row.ppid === 1)!;
    await lan.pc2.executeCommand(`sudo kill ${daemon.pid}`);
    await settle();
    expect(await who(lan.pc2)).toContain('user');
    expect(await sessionProcesses(lan.pc2)).toHaveLength(2);
    expect(await lan.pc1.executeCommand('ss -tln sport = :9003')).toContain('9003');
    expect(await closedLines(lan.pc2)).toBe(0);
  });

  it('the telnet daemon is not an sshd monitor: killing it ends its connection and logs no logind session', async () => {
    await telnetSession();
    expect(await who(lan.pc2)).toContain('user');
    const daemon = (await processes(lan.pc2)).find((row) => row.comm === 'in.telnetd')!;
    await lan.pc2.executeCommand(`sudo kill ${daemon.pid}`);
    await settle();
    expect(await who(lan.pc2)).toBe('');
    expect(await closedLines(lan.pc2)).toBe(0);
  });
});
