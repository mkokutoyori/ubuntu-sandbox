/**
 * Le `ssh` tape dans un terminal est un processus de la machine, enfant du shell de ce terminal : `ps` le liste
 * avec sa ligne de commande et son terminal, `ss -p` et `lsof` lui donnent la connexion vers le serveur et chacune
 * de ses redirections `-L` et `-D`, `kill` sur son pid raccroche la session, et il disparait quand elle finit.
 *
 * Mesure de depart (608f58462 + le lot des processus de session sshd), un LinuxPC et un LinuxServer cables,
 * `ssh -o StrictHostKeyChecking=accept-new -L 9003:10.0.9.2:22 alice@10.0.9.2` tape dans un
 * `LinuxTerminalSession` : `ps` du poste ne listait aucun `ssh` (deux `-bash` et le `ps` lui-meme), la connexion
 * ESTAB vers le port 22 et l'ecoute 127.0.0.1:9003 n'avaient aucun proprietaire pour `ss -tnp`, `lsof -i` ne les
 * listait pas et il n'y avait rien a tuer. Le chemin `executeCommand` (`ssh -f -N -L`) avait son processus : deux
 * ecritures pour un meme fait. Les deux chemins ecrivaient aussi deux fois la grammaire de `-L`, `-R` et `-D`
 * (`sshArgs.ts` et `SshPortForward.parse`) et deux fois l'orchestration des ecoutes (`installLocalForwards` et
 * ses deux soeurs, `SshForwardingTable`) ; la copie du terminal etait la moins capable : `-L 0.0.0.0:9003:h:22`
 * ouvrait 127.0.0.1:9003, l'adresse de liaison etant lue puis jetee (les tests L2 et R2 epinglaient
 * « bindAddress ignored »).
 *
 * Autorites : ssh(1) d'OpenSSH 8.9p1 (source de la page lue, raw.githubusercontent.com/openssh/openssh-portable/
 * V_8_9_P1/ssh.1) pour `-L` et `-D` : l'ecoute est allouee par le client ssh, `localhost` la lie a la boucle
 * locale, `*` ou une adresse vide a toutes les interfaces, et a defaut c'est GatewayPorts qui decide ; le noyau
 * pour l'appartenance d'une socket au processus qui tient son descripteur.
 *
 * Ce qui est construit : `LinuxMachine.openSshClientProcess` et `LinuxCommandExecutor.openTerminalSshClient`
 * (un processus `ssh` enfant du shell du terminal, sur son tty, qui adopte la session et la ligne de la table des
 * sockets) ; le terminal ouvre ses redirections par `openSshLocalForward` et `openSshRemoteForward`, donc par la
 * `SshForwardingTable` du chemin `executeCommand`, avec l'identite du processus ; `sshArgs.ts` produit des
 * `SshPortForward` (une seule grammaire, l'adresse de liaison est evaluee) et ses types `LocalForward`,
 * `RemoteForward`, `DynamicForward` et leurs trois analyseurs n'existent plus ; la fin de la session (exit,
 * raccrochage, `kill`) retire le processus, ferme les ecoutes et raccroche la connexion. Les tests L1 a L5, R1 a
 * R5 et D1 a D5 sont portes sur `SshPortForward.parse` (L2 et R2 figeaient le defaut).
 *
 * Ce qui n'est PAS construit : un `ssh` tape dans une session distante deja ouverte (sous-shell imbrique) n'a pas
 * de processus ; `ssh -N` et `-f` ne sont pas lus par le terminal, qui ouvre toujours un shell ; la forme a
 * adresse vide `-L :8080:h:80` et la syntaxe a deux arguments de ssh_config (`LocalForward 8080 h:80`) ne sont
 * pas reconnues ; le pied de page d'un `kill` est celui d'un raccrochage, pas la ligne `Killed by signal 15.`.
 *
 * Discrimination (fichier copie sur le commit precedent, `git stash push -- src/network src/terminal`) : ONZE
 * cas sur douze tombent ; le douzieme est le TEMOIN (le banc : une session de terminal atteint le shell distant
 * et en sort). Mutations : ne plus retirer le processus a la fin de la session fait tomber 2 cas ; ne plus
 * donner la connexion au processus 2 ; ne plus lui faire adopter la session 1 (le `kill` d'une session sans
 * redirection) ; passer l'uid 0 aux ecoutes n'en fait tomber aucun, et c'est un mutant equivalent : l'uid
 * affiche vient du processus proprietaire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const MASK = new SubnetMask('255.255.255.0');
const CLIENT_IP = '10.0.9.1';
const SERVER_IP = '10.0.9.2';

const key = (name: string): KeyEvent =>
  ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 30): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

interface Lab {
  readonly client: LinuxPC;
  readonly server: LinuxServer;
  readonly terminal: LinuxTerminalSession;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly user: string;
  readonly tty: string;
  readonly comm: string;
  readonly args: string;
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

async function lab(): Promise<Lab> {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const switchBox = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  client.configureInterface('eth0', new IPAddress(CLIENT_IP), MASK);
  server.configureInterface('eth0', new IPAddress(SERVER_IP), MASK);
  new Cable('c1').connect(client.getPort('eth0')!, switchBox.getPorts()[0]);
  new Cable('c2').connect(server.getPort('eth0')!, switchBox.getPorts()[1]);
  await server.executeCommand('useradd -m alice');
  await server.executeCommand('sh -c "echo \'alice:secret\' | chpasswd"');
  const terminal = new LinuxTerminalSession('t', client);
  await terminal.init();
  return { client, server, terminal };
}

async function connect(terminal: LinuxTerminalSession, options = ''): Promise<void> {
  terminal.setInput(`ssh -o StrictHostKeyChecking=accept-new ${options} alice@${SERVER_IP}`.replace(/\s+/g, ' '));
  terminal.handleKey(key('Enter'));
  await flush();
  if (terminal.currentInputMode.type === 'password') {
    terminal.setPasswordBuf('secret');
    terminal.handleKey(key('Enter'));
    await flush();
  }
}

async function typeLine(terminal: LinuxTerminalSession, text: string): Promise<void> {
  terminal.setInput(text);
  terminal.setInputBuf(text);
  terminal.handleKey(key('Enter'));
  await flush();
}

function transcript(terminal: LinuxTerminalSession): string {
  return terminal.lines.map((line) => (typeof line === 'string' ? line : line.text ?? '')).join('\n');
}

async function processes(machine: LinuxPC | LinuxServer): Promise<ProcessRow[]> {
  const listing = await machine.executeCommand('ps -eo pid,ppid,user,tty,comm,args');
  return listing.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    return match === null
      ? []
      : [{ pid: Number(match[1]), ppid: Number(match[2]), user: match[3], tty: match[4], comm: match[5], args: match[6] }];
  });
}

async function sshClients(machine: LinuxPC): Promise<ProcessRow[]> {
  return (await processes(machine)).filter((row) => row.comm === 'ssh');
}

async function theSshClient(machine: LinuxPC): Promise<ProcessRow> {
  const rows = await sshClients(machine);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('the bench is sound (witnesses)', () => {
  it('a terminal session reaches the remote shell and leaves it again', async () => {
    const { terminal, server } = await lab();
    await connect(terminal);
    await typeLine(terminal, 'hostname');
    expect(transcript(terminal)).toContain(server.getHostname());
    await typeLine(terminal, 'exit');
    expect(transcript(terminal)).toContain(`Connection to ${SERVER_IP} closed.`);
  });
});

describe('the ssh typed in a terminal is a process of the machine, child of that terminal shell', () => {
  it('ps lists one ssh of the terminal user, on the terminal tty, with the typed command line', async () => {
    const { client, terminal } = await lab();
    await connect(terminal);
    const row = await theSshClient(client);
    expect(row).toBeDefined();
    expect(row.args).toBe(`ssh -o StrictHostKeyChecking=accept-new alice@${SERVER_IP}`);
    expect(row.user).toBe('user');
    const parent = (await processes(client)).find((candidate) => candidate.pid === row.ppid);
    expect(parent?.comm).toBe('-bash');
    expect(parent?.tty).toBe(row.tty);
    expect(row.tty).toMatch(/^pts\/\d+$/);
  });

  it('the connection to the server belongs to it for ss and for lsof', async () => {
    const { client, terminal } = await lab();
    await connect(terminal);
    const row = await theSshClient(client);
    const sockets = await client.executeCommand(`sudo ss -tnp state established dport = :22`);
    expect(sockets).toMatch(new RegExp(`${SERVER_IP}:22\\s.*users:\\(\\("ssh",pid=${row.pid},fd=\\d+\\)\\)`));
    expect(await client.executeCommand('sudo lsof -i -n -P')).toMatch(
      new RegExp(`ssh\\s+${row.pid}\\s+user\\s.*${CLIENT_IP}:\\d+->${SERVER_IP}:22 \\(ESTABLISHED\\)`));
  });

  it('a session with no forward owns nothing else', async () => {
    const { client, terminal } = await lab();
    await connect(terminal);
    const row = await theSshClient(client);
    const mine = await client.executeCommand(`ls -l /proc/${row.pid}/fd`);
    expect((mine.match(/socket:\[\d+\]/g) ?? []).length).toBe(1);
  });
});

describe('the forwards of a terminal session belong to its ssh process', () => {
  it('-L: the listener is named by the ssh pid, owned by the user, bound as typed', async () => {
    const { client, terminal } = await lab();
    await connect(terminal, `-L 9003:${SERVER_IP}:22`);
    const row = await theSshClient(client);
    expect(await client.executeCommand('ss -tlnp sport = :9003')).toMatch(
      new RegExp(`127\\.0\\.0\\.1:9003\\s.*users:\\(\\("ssh",pid=${row.pid},fd=\\d+\\)\\)`));
    expect(await client.executeCommand('sudo ss -tlne sport = :9003')).toMatch(/uid:1000/);
    expect(await client.executeCommand('sudo lsof -i :9003 -n -P')).toMatch(
      new RegExp(`ssh\\s+${row.pid}\\s+user\\s.*127\\.0\\.0\\.1:9003 \\(LISTEN\\)`));
  });

  it('-L with a bind address honours it', async () => {
    const { client, terminal } = await lab();
    await connect(terminal, `-L 0.0.0.0:9003:${SERVER_IP}:22`);
    expect(await client.executeCommand('ss -tln sport = :9003')).toMatch(/0\.0\.0\.0:9003/);
  });

  it('-D: the SOCKS listener is named by the ssh pid', async () => {
    const { client, terminal } = await lab();
    await connect(terminal, '-D 1080');
    const row = await theSshClient(client);
    expect(await client.executeCommand('ss -tlnp sport = :1080')).toMatch(
      new RegExp(`127\\.0\\.0\\.1:1080\\s.*users:\\(\\("ssh",pid=${row.pid},fd=\\d+\\)\\)`));
  });

  it('two forwards of one command belong to one process', async () => {
    const { client, terminal } = await lab();
    await connect(terminal, `-L 9003:${SERVER_IP}:22 -L 9004:${SERVER_IP}:22`);
    const rows = await sshClients(client);
    expect(rows).toHaveLength(1);
    const listing = await client.executeCommand('ss -tlnp');
    const pids = [...listing.matchAll(/127\.0\.0\.1:900[34]\s.*pid=(\d+)/g)].map((match) => Number(match[1]));
    expect(pids).toEqual([rows[0].pid, rows[0].pid]);
  });
});

describe('the process lives and dies with the session', () => {
  it('exit in the remote shell removes the process, the listener and the connection', async () => {
    const { client, terminal } = await lab();
    await connect(terminal, `-L 9003:${SERVER_IP}:22`);
    expect(await sshClients(client)).toHaveLength(1);
    await typeLine(terminal, 'exit');
    expect(await sshClients(client)).toEqual([]);
    expect(await client.executeCommand('ss -tln sport = :9003')).not.toContain('9003');
    expect(await client.executeCommand('sudo ss -tnp dport = :22')).not.toMatch(/users:/);
  });

  it('kill of the ssh pid from another shell hangs the session up: footer in the terminal, listener closed, server session gone', async () => {
    const { client, server, terminal } = await lab();
    await connect(terminal, `-L 9003:${SERVER_IP}:22`);
    const row = await theSshClient(client);
    expect(await server.executeCommand('who')).toMatch(/alice/);
    await client.executeCommand(`kill ${row.pid}`);
    await flush();
    expect(await sshClients(client)).toEqual([]);
    expect(await client.executeCommand('ss -tln sport = :9003')).not.toContain('9003');
    expect(transcript(terminal)).toContain(`Connection to ${SERVER_IP} closed`);
    expect(await server.executeCommand('who')).not.toMatch(/alice/);
    expect((await processes(server)).filter((candidate) => candidate.args === 'sshd: alice [priv]')).toEqual([]);
  });

  it('kill of the ssh pid of a plain session, with no forward at all, hangs it up as well', async () => {
    const { client, server, terminal } = await lab();
    await connect(terminal);
    const row = await theSshClient(client);
    await client.executeCommand(`kill ${row.pid}`);
    await flush();
    expect(await sshClients(client)).toEqual([]);
    expect(transcript(terminal)).toContain(`Connection to ${SERVER_IP} closed`);
    expect(await server.executeCommand('who')).not.toMatch(/alice/);
  });

  it('a second terminal session is a second process', async () => {
    const { client, terminal } = await lab();
    await connect(terminal);
    const first = await sshClients(client);
    expect(first).toHaveLength(1);
    const other = new LinuxTerminalSession('t2', client);
    await other.init();
    await connect(other);
    const both = await sshClients(client);
    expect(both).toHaveLength(2);
    expect(new Set(both.map((row) => row.tty)).size).toBe(2);
    await typeLine(terminal, 'exit');
    const left = await sshClients(client);
    expect(left).toHaveLength(1);
    expect(left[0].pid).toBe(both.find((row) => row.pid !== first[0].pid)!.pid);
  });
});
