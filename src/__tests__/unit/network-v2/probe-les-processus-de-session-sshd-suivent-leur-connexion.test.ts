/**
 * Les processus d'une session sshd (`sshd: user [priv]` et le `-bash` qu'il porte) vivent exactement aussi
 * longtemps que la connexion TCP qui les porte, et deux sessions du meme utilisateur depuis le meme poste sont
 * deux sessions : la fin de l'une ne touche ni les processus ni la connexion de l'autre.
 *
 * Mesure de depart (origin/mandeng 608f58462), trois LinuxPC cables (`ssh-lan-fixtures`) : apres `ssh user@pc2
 * true`, apres une session interactive nourrie sur l'entree standard et apres une session ouverte dans le
 * terminal puis fermee par `exit`, `ps` du serveur listait toujours `sshd: user [priv]` et `-bash` (quatre paires
 * apres quatre commandes, chacune sur un `pts/N` de plus) alors que `who`, `w` et `loginctl` disaient que
 * personne n'etait connecte : `closeSshSessionRecord` appelait `reap`, qui n'agit que sur un zombie. Le pid que
 * `loginctl show-session` donne pour `Leader` restait dans `ps` apres la fin de la session. Et l'enregistrement
 * se fermait par `(utilisateur, adresse)` en prenant le plus ancien : la fin d'une commande depuis le meme poste
 * fermait l'enregistrement du tunnel `ssh -f -N -L` ouvert avant elle, si bien que faire sortir les processus
 * aurait tue le tunnel en silence. Le faucheur de sockets de `LinuxMachine` retirait enfin toute ligne de la
 * table des sockets portant la meme adresse locale (`unbind`), donc celle d'une autre connexion sur le port 22.
 *
 * Autorites : OpenSSH 8.9p1, sources lues (raw.githubusercontent.com/openssh/openssh-portable/V_8_9_P1) :
 * monitor.c:728 donne le titre `user [priv]` au moniteur, session.c:2556 le titre `user@tty` (ou `user@notty`)
 * a l'enfant sans privilege, sshd.c:2076 le titre `[accepted]` avant l'authentification, et monitor_wrap.c:149
 * fait sortir le moniteur (`cleanup_exit(255)`) quand l'enfant ferme son bout de la paire de sockets, donc a la
 * fin de la session ; le noyau pour le reste : un processus qui sort quitte la table des processus, et `ps`,
 * `who` et `loginctl` lisent le meme fait.
 *
 * Ce qui est construit : l'enregistrement de session porte le port source de SA connexion (`fromPort`), pris
 * en reclamant la socket acceptee de ce poste qu'aucun enregistrement ouvert ne tient ; il se ferme par ce port
 * (`connectionClosed` recoit le port de la connexion qui se ferme, `scheduleSshLogout` celui que
 * `openSshSessionRecord` a rendu) et fait alors sortir le shell puis le moniteur ; le faucheur de sockets retire
 * une ligne de connexion par son quadruplet et ne fait `unbind` que pour une ecoute.
 *
 * Ce qui n'est PAS construit : l'enfant sans privilege `sshd: user@pts/0`, qui tient la connexion avec le
 * moniteur dans un vrai Linux (ici le shell est l'enfant du moniteur et le moniteur seul tient la socket) ; une
 * session sans terminal (`ssh hote commande`) prend encore un numero de pts ; et la mort d'un processus qui
 * detient une connexion vivante (`kill` du moniteur) abat toujours la socket sans FIN (le pair garde ESTAB).
 *
 * Discrimination (fichier copie sur 608f58462, `git stash push -- src/network`) : DIX cas sur quatorze tombent.
 * Les quatre autres passent des deux cotes : deux TEMOINS (un tunnel en cours est une session : un moniteur et
 * son shell, listes par `ps` et `loginctl` ; une session ouverte puis close laisse la table des sessions vide)
 * et deux GARDE-FOUS qui passent faute de tout processus qui sorte et ne tombent que si l'on fait sortir sans
 * identifier la connexion (le tunnel relaie encore des octets ; sa connexion reste a son enfant). Mutations :
 * fermer le plus ancien enregistrement sans regarder le port fait tomber 3 cas (les deux garde-fous et celui
 * des pid) ; remettre `unbind` dans le faucheur en fait tomber 1 ; ne plus reclamer la socket acceptee en fait
 * tomber 1 (les deux dernieres sont le cas du `kill` d'un moniteur).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { LinuxPC } from '@/network/devices/LinuxPC';
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

async function tunnel(forward = `9003:${PC3_IP}:8080`, flags = '-f -N', user = 'user'): Promise<void> {
  await lan.pc1.executeCommand(`ssh ${flags} -L ${forward} ${user}@${PC2_IP}`, 'admin\n');
}

async function sshClientPids(): Promise<number[]> {
  return (await processes(lan.pc1)).filter((row) => row.comm === 'ssh').map((row) => row.pid);
}

function echoOn(machine: LinuxPC, port: number): void {
  machine.getTcpStack().listen(port, {
    onAccept: (socket) => socket.onData((data) => socket.send(`ECHO:${String(data)}`)),
  });
}

async function loginctlSessions(machine: LinuxPC): Promise<number> {
  const listing = await machine.executeCommand('loginctl list-sessions');
  return Number(/(\d+) sessions? listed\./.exec(listing)?.[1] ?? 0);
}

describe('the bench is sound (witnesses)', () => {
  it('a tunnel in progress is one session: a monitor and its shell, listed by ps and by loginctl', async () => {
    await tunnel();
    const rows = await sessionProcesses(lan.pc2);
    expect(rows.map((row) => row.comm)).toEqual(['sshd', '-bash']);
    expect(rows[1].ppid).toBe(rows[0].pid);
    expect(rows[0].user).toBe('root');
    expect(rows[1].user).toBe('user');
    expect(await loginctlSessions(lan.pc2)).toBeGreaterThanOrEqual(1);
  });

  it('a session opened and closed leaves the session table empty', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    expect(await lan.pc2.executeCommand('who')).not.toMatch(/pts\//);
  });
});

describe('the processes of a session end with the session', () => {
  it('ssh host command leaves no session process on the server', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
  });

  it('several commands in a row leave the process table where it was', async () => {
    const before = (await processes(lan.pc2)).length;
    for (let round = 0; round < 3; round += 1) {
      await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    }
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
    expect((await processes(lan.pc2)).length - before).toBeLessThanOrEqual(1);
  });

  it('an interactive session fed on standard input leaves no session process', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP}`, 'admin\nhostname\nexit\n');
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
  });

  it('ps, who and loginctl say the same thing after the session: nobody', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP}`, 'admin\nhostname\nexit\n');
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
    expect(await lan.pc2.executeCommand('who')).not.toMatch(/pts\//);
    const sessions = await lan.pc2.executeCommand('loginctl list-sessions');
    expect(sessions).not.toMatch(/\buser\b.*pts/);
  });

  it('the pid loginctl names as the session leader is gone from ps afterwards', async () => {
    await tunnel();
    const listing = await lan.pc2.executeCommand('loginctl list-sessions');
    const sid = listing.split('\n').find((line) => /\bpts\//.test(line))?.trim().split(/\s+/)[0] ?? '';
    expect(sid).toMatch(/^\d+$/);
    const leader = /^Leader=(\d+)$/m.exec(await lan.pc2.executeCommand(`loginctl show-session ${sid}`))?.[1] ?? '';
    expect((await processes(lan.pc2)).some((row) => row.pid === Number(leader))).toBe(true);
    const [client] = await sshClientPids();
    await lan.pc1.executeCommand(`kill ${client}`);
    await settle();
    expect((await processes(lan.pc2)).some((row) => row.pid === Number(leader))).toBe(false);
  });
});

describe('two sessions of one user from one machine are two sessions', () => {
  it('the end of a command leaves the tunnel own processes in place, pid for pid', async () => {
    await tunnel();
    const tunnelRows = await sessionProcesses(lan.pc2);
    expect(tunnelRows).toHaveLength(2);
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    const after = await sessionProcesses(lan.pc2);
    expect(after.map((row) => row.pid)).toEqual(tunnelRows.map((row) => row.pid));
  });

  it('the tunnel still carries bytes once the command has ended', async () => {
    echoOn(lan.pc3, 8080);
    await tunnel();
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    const replies: string[] = [];
    const socket = lan.pc1.getTcpStack().connect('127.0.0.1', 9003, { onData: (data) => replies.push(String(data)) });
    await settle();
    socket?.send('PING');
    await settle();
    expect(replies.join('')).toBe('ECHO:PING');
  });

  it('the tunnel connection is still owned on the server by the tunnel session child', async () => {
    await tunnel();
    const [monitor] = await sessionProcesses(lan.pc2);
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    const owned = await lan.pc2.executeCommand('sudo ss -tnp state established sport = :22');
    expect(owned).toMatch(new RegExp(`users:\\(\\("sshd",pid=${monitor.pid},fd=\\d+\\)\\)`));
  });

  it('killing the tunnel client ends the tunnel session on the server and spares the other one', async () => {
    await tunnel();
    await tunnel(`9004:${PC3_IP}:8081`);
    const both = await sessionProcesses(lan.pc2);
    expect(both).toHaveLength(4);
    const clients = await sshClientPids();
    expect(clients).toHaveLength(2);
    await lan.pc1.executeCommand(`kill ${clients[0]}`);
    await settle();
    const left = await sessionProcesses(lan.pc2);
    expect(left).toHaveLength(2);
    expect(await lan.pc1.executeCommand('ss -tln sport = :9004')).toContain('9004');
    expect(await lan.pc1.executeCommand('ss -tln sport = :9003')).not.toContain('9003');
  });

  it('killing the monitor of one session leaves the other connection owned by its own monitor', async () => {
    await tunnel();
    await tunnel(`9004:${PC3_IP}:8081`);
    const monitors = (await sessionProcesses(lan.pc2)).filter((row) => row.comm === 'sshd');
    expect(monitors).toHaveLength(2);
    await lan.pc2.executeCommand(`sudo kill ${monitors[0].pid}`);
    const listing = await lan.pc2.executeCommand('sudo ss -tnp state established sport = :22');
    expect(listing).toContain(`pid=${monitors[1].pid}`);
    expect(listing).not.toContain(`pid=${monitors[0].pid}`);
    expect(listing.split('\n').filter((line) => /10\.0\.0\.1:\d+/.test(line))).toHaveLength(1);
    expect(lan.pc2.getTcpStack().listSockets().filter((socket) => socket.localPort === 22)).toHaveLength(1);
  });

  it('the sessions of two users do not touch each other', async () => {
    await tunnel(`9003:${PC3_IP}:8080`, '-f -N', 'user');
    await lan.pc1.executeCommand(`ssh alice@${PC2_IP} true`, 'alice\n');
    expect(await sessionProcesses(lan.pc2, 'user')).toHaveLength(2);
    expect(await sessionProcesses(lan.pc2, 'alice')).toEqual([]);
  });
});

describe('the connection is not shortened by the end of a session record', () => {
  it('a session that outlives its command (sleep) keeps its processes until the hold ends', async () => {
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    EquipmentRegistry.getInstance().clear();
    lan = buildLan();
    await assignIps(lan);
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} sleep 30`, 'admin\n');
    expect(await sessionProcesses(lan.pc2)).toHaveLength(2);
    scheduler.advance(29_000);
    expect(await sessionProcesses(lan.pc2)).toHaveLength(2);
    scheduler.advance(2_000);
    expect(await sessionProcesses(lan.pc2)).toEqual([]);
  });
});
