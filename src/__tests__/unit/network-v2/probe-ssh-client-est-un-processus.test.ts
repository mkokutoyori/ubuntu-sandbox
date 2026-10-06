/**
 * Un tunnel SSH qui survit a la commande est un processus de la machine qui l'a ouvert. `ssh -f -N -L`
 * (comme `-D` et `-R`) laisse un processus `ssh` de l'utilisateur, detache du shell avec `-f` (parent 1,
 * pas de terminal) et enfant du shell sans lui ; il tient l'ecoute locale et la connexion au serveur, `ps`
 * le liste, `ss -p` et `lsof` le nomment par ce meme pid, et un `kill` sur ce pid ferme l'ecoute, la
 * connexion et la redirection distante. Un `ssh` qui ne laisse rien derriere lui ne laisse aucun processus.
 *
 * Mesure de depart (origin/mandeng 75c5280d8), trois LinuxPC cables (`ssh-lan-fixtures`), `ssh -f -N -L
 * 9003:... user@pc2` : `ps` ne listait aucun processus `ssh` ; l'ecoute 127.0.0.1:9003 appartenait au pid
 * 2200, une constante ecrite en dur dans `LinuxSshClient` (`SSH_CLIENT_FORWARD_PID`) qui n'existait dans
 * aucune table de processus ; la connexion vers le serveur n'avait aucun proprietaire ; aucun `kill` ne
 * pouvait fermer le tunnel. L'ancien `ss -p` imprimait `"ssh"` parce qu'il recopiait le nom de la table des
 * sockets : `ps` et `ss` se contredisaient sur le meme instant.
 *
 * Autorites : ssh(1) d'OpenSSH pour `-f` (le client passe en arriere-plan avant la commande), `-N` (pas de
 * commande distante), `-L`, `-R` et `-D` ; le noyau pour l'appartenance d'une prise au processus qui tient
 * son descripteur (`/proc/<pid>/fd`). Le detachement suit le precedent du depot pour `nohup cmd &` (parent
 * 1, pas de terminal) ; un Linux qui execute `systemd --user` reparente plutot chez le gestionnaire de
 * l'utilisateur, ce que la machine ne modelise pas.
 *
 * Ce qui est construit : `LinuxCommandExecutor.sshClientProcess` (le processus naît a la premiere ecoute ou
 * quand la session est retenue, et disparait si rien ne reste), `SshForwardingTable.adopt`, `closeOwnedBy`
 * et `onClientReleased` (la session et ses redirections appartiennent a un pid), `SshSession.localEndpoint`,
 * `WireExecTarget.forksToBackground` et l'appel de `releaseSshClient` par le reaper de `LinuxMachine` a la
 * mort du processus.
 *
 * Ce qui n'est PAS construit : le chemin du terminal interactif (`LinuxTerminalSession`) ouvre toujours ses
 * ecoutes `-L` sans processus proprietaire ; et le serveur laisse les processus de session (`sshd: user
 * [priv]` et `-bash`) dans `ps` apres la fin de la session, defaut anterieur a ce changement : `reap`
 * n'agit que sur un zombie et `terminate` n'en laisse aucun.
 *
 * Discrimination (fichier copie sur origin/mandeng 75c5280d8) : NEUF cas sur onze tombent. Les deux autres
 * passent des deux cotes : un TEMOIN (un tunnel relaie des octets et `ps` liste `sshd` des deux cotes : le
 * labo est sain) et une NON-REGRESSION (une commande `ssh` qui ne laisse rien derriere elle ne laisse pas de
 * processus, ce qui etait deja vrai faute de tout processus).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildLan, assignIps, PC2_IP, PC3_IP, type SshLan } from './ssh-lan-fixtures';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
});

async function tunnel(flags: string, forward = `9003:${PC3_IP}:8080`): Promise<void> {
  await lan.pc1.executeCommand(`ssh ${flags} -L ${forward} user@${PC2_IP}`, 'admin\n');
}

async function sshRows(): Promise<string[]> {
  const listing = await lan.pc1.executeCommand('ps -eo pid,ppid,uid,tty,comm,args');
  return listing.split('\n').filter((line) => /\sssh\s/.test(line));
}

function pidOf(row: string): number {
  return Number(row.trim().split(/\s+/)[0]);
}

describe('the bench is sound (witnesses)', () => {
  it('a tunnel relays bytes, and ps lists sshd on both machines', async () => {
    lan.pc3.getTcpStack().listen(8080, {
      onAccept: (socket) => socket.onData((data) => socket.send(`ECHO:${String(data)}`)),
    });
    await tunnel('-f -N');
    const replies: string[] = [];
    const socket = lan.pc1.getTcpStack().connect('127.0.0.1', 9003, { onData: (data) => replies.push(String(data)) });
    await settle();
    socket?.send('PING');
    await settle();
    expect(replies.join('')).toBe('ECHO:PING');
    expect(await lan.pc1.executeCommand('ps -e')).toContain('sshd');
    expect(await lan.pc2.executeCommand('ps -e')).toContain('sshd');
  });
});

describe('a tunnel that outlives the command is a process of the machine that opened it', () => {
  it('ssh -f -N -L leaves one ssh process of the user, detached from the shell, with its command line', async () => {
    await tunnel('-f -N');
    const rows = await sshRows();
    expect(rows).toHaveLength(1);
    const [pid, ppid, uid, tty] = rows[0].trim().split(/\s+/);
    expect(Number(pid)).toBeGreaterThan(1);
    expect(ppid).toBe('1');
    expect(uid).toBe('1000');
    expect(tty).toBe('?');
    expect(rows[0]).toContain(`ssh -f -N -L 9003:${PC3_IP}:8080 user@${PC2_IP}`);
  });

  it('the process the listener names is the process ps lists, whoever asks', async () => {
    await tunnel('-f -N');
    const pid = pidOf((await sshRows())[0]);
    const asUser = await lan.pc1.executeCommand('ss -tlnp');
    const asRoot = await lan.pc1.executeCommand('sudo ss -tlnpe');
    expect(asUser).toMatch(new RegExp(`127\\.0\\.0\\.1:9003\\s.*users:\\(\\("ssh",pid=${pid},fd=\\d+\\)\\)`));
    expect(asRoot).toMatch(new RegExp(`127\\.0\\.0\\.1:9003\\s.*users:\\(\\("ssh",pid=${pid},fd=\\d+\\)\\).*uid:1000`));
    expect(await lan.pc1.executeCommand('sudo lsof -i :9003 -n -P')).toMatch(new RegExp(`ssh\\s+${pid}\\s+user\\s.*127\\.0\\.0\\.1:9003 \\(LISTEN\\)`));
  });

  it('the connection to the server is held by the same process, and its descriptors are listed', async () => {
    await tunnel('-f -N');
    const pid = pidOf((await sshRows())[0]);
    const established = await lan.pc1.executeCommand(`ss -tnp state established dport = :22`);
    expect(established).toMatch(new RegExp(`${PC2_IP}:22\\s.*users:\\(\\("ssh",pid=${pid},fd=\\d+\\)\\)`));
    const descriptors = await lan.pc1.executeCommand(`ls -l /proc/${pid}/fd`);
    expect((descriptors.match(/socket:\[\d+\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('without -f the process is a child of the shell and keeps its terminal', async () => {
    await tunnel('-N');
    const [row] = await sshRows();
    const [, ppid, , tty] = row.trim().split(/\s+/);
    expect(Number(ppid)).toBeGreaterThan(1);
    expect(tty).toBe('pts/0');
  });

  it('two forwards of one command belong to one process', async () => {
    await lan.pc1.executeCommand(
      `ssh -f -N -L 9003:${PC3_IP}:8080 -L 9004:${PC3_IP}:8081 user@${PC2_IP}`, 'admin\n');
    const rows = await sshRows();
    expect(rows).toHaveLength(1);
    const ss = await lan.pc1.executeCommand('ss -tlnp');
    const pids = [...ss.matchAll(/127\.0\.0\.1:900[34]\s.*pid=(\d+)/g)].map((m) => Number(m[1]));
    expect(pids).toEqual([pidOf(rows[0]), pidOf(rows[0])]);
  });

  it('a dynamic forward is owned by the same kind of process', async () => {
    await lan.pc1.executeCommand(`ssh -f -N -D 1080 user@${PC2_IP}`, 'admin\n');
    const [row] = await sshRows();
    const pid = pidOf(row);
    expect(await lan.pc1.executeCommand('ss -tlnp')).toMatch(new RegExp(`127\\.0\\.0\\.1:1080\\s.*users:\\(\\("ssh",pid=${pid},fd=\\d+\\)\\)`));
  });

  it('a command that leaves nothing behind leaves no process behind', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    expect(await sshRows()).toEqual([]);
  });
});

describe('the tunnel lives and dies with its process', () => {
  it('kill closes the listener and the connection, and the server sees the session end on the wire', async () => {
    await tunnel('-f -N');
    const pid = pidOf((await sshRows())[0]);
    expect(await lan.pc2.executeCommand('sudo ss -tn state established sport = :22')).toContain(PC2_IP);
    const before = lan.pc1.getTcpStack().listSockets().filter((socket) => socket.remotePort === 22).length;
    expect(before).toBe(1);
    await lan.pc1.executeCommand(`kill ${pid}`);
    expect(await sshRows()).toEqual([]);
    expect(await lan.pc1.executeCommand('ss -tln sport = :9003')).not.toContain('9003');
    expect(lan.pc1.getTcpStack().connect('127.0.0.1', 9003)?.state).not.toBe('established');
    expect(lan.pc1.getTcpStack().listSockets().filter((socket) => socket.remotePort === 22 && socket.state === 'established')).toEqual([]);
    expect(await lan.pc1.executeCommand('ss -tn state established dport = :22')).not.toContain(PC2_IP);
    expect(await lan.pc2.executeCommand('sudo ss -tn state established sport = :22')).not.toContain(PC2_IP);
  });

  it('a remote forward is held by the process too: the listener on the server dies with it', async () => {
    await lan.pc1.executeCommand(`ssh -f -N -R 9100:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    const rows = await sshRows();
    expect(rows).toHaveLength(1);
    expect(await lan.pc2.executeCommand('sudo ss -tln sport = :9100')).toContain('9100');
    await lan.pc1.executeCommand(`kill ${pidOf(rows[0])}`);
    expect(await lan.pc2.executeCommand('sudo ss -tln sport = :9100')).not.toContain('9100');
  });

  it('an unrelated process dying leaves the tunnel alone', async () => {
    await tunnel('-f -N');
    await lan.pc1.executeCommand('sleep 100 &');
    const sleeper = await lan.pc1.executeCommand('pgrep sleep');
    await lan.pc1.executeCommand(`kill ${sleeper.trim()}`);
    expect(await lan.pc1.executeCommand('ss -tln sport = :9003')).toContain('9003');
    expect(await sshRows()).toHaveLength(1);
  });
});
