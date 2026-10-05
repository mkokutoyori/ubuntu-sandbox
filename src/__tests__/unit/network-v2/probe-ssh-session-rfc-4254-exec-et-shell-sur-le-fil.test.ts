/*
 * Sonde -- exec et shell voyagent dans des canaux `session' de la RFC 4254,
 * et non dans des enveloppes JSON `{"op":"exec"}' / `{"op":"shell_input"}'.
 *
 * MESURE DE DEPART (base : etapes A et B livrees, canaux JSON). Un client
 * RFC 4254 independant, une fois authentifie (SSH_MSG_USERAUTH_SUCCESS),
 * ouvrait un canal : SSH_MSG_CHANNEL_OPEN 90 `session' n'etait jamais
 * confirme, le serveur n'ecoutant que des objets JSON portes par le message
 * local 192 ; `exec', `pty-req' et `shell' etaient du bruit. Un `ssh' reel
 * se figeait apres l'authentification. Meme defaut cote client : un exec
 * etait un `{"op":"exec"}' et son resultat un objet JSON.
 *
 * AUTORITES. RFC 4254 §6.1 (session), §6.2 (pty-req : terminal, colonnes,
 * lignes, modes codes en §8 -- ECHO 53, ONLCR 72), §6.5 (exec, shell,
 * subsystem), §6.10 (exit-status), §5.2 (EXTENDED_DATA type 1 = stderr),
 * §5.1 (OPEN_FAILURE 3 pour un type inconnu), §4 (requete globale
 * keepalive@openssh.com -> REQUEST_FAILURE, PROTOCOL d'OpenSSH). Le
 * comportement de sshd vient de session.c / serverloop.c d'OpenSSH 8.9p1 :
 * MaxSessions refuse un canal supplementaire avec OPEN_FAILURE 1
 * (administratively prohibited, « open failed »), un shell ferme le canal
 * (exit-status, EOF, CLOSE) quand l'entree se termine.
 *
 * Eprouve HORS DEPOT contre l'`ssh' 8.9p1 REEL compile depuis les sources,
 * sur une vraie socket, contre le serveur SSH d'un CiscoRouter simule :
 * `ssh admin@... "show clock"' rend l'heure et le code 0 ; `ssh -tt' ouvre
 * une session, affiche la banniere puis l'invite `R1#', execute
 * `show version | include Version', `enable', `show privilege' (« Current
 * privilege level is 15 ») et se ferme sur `exit' (« Connection to ...
 * closed. ») ; `ssh -T' sans pty se termine proprement a la fin de
 * l'entree.
 *
 * DISCRIMINATION (`git stash' des fichiers suivis) : tous les cas sauf le
 * TEMOIN tombent avant le correctif -- le temoin (authentification par mot
 * de passe jusqu'a USERAUTH_SUCCESS) prouve que le laboratoire joint le
 * serveur et que la couche transport/authentification est saine. Les
 * numeros de messages sont ecrits en clair (RFC 4254 §9), non importes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { TcpStream } from '@/network/tcp/types';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { SshConnection, type ConnectionChannel } from '@/network/protocols/ssh/connection/SshConnection';
import { encodeUserauthRequest } from '@/network/protocols/ssh/auth/UserauthMessages';
import { encodePtyRequest, encodeStringPayload, decodeExitStatus } from '@/network/protocols/ssh/connection/ChannelPayloads';
import { resolveAlgorithmDirectives } from '@/network/protocols/ssh/transport/SshAlgorithms';
import { bytesToUtf8 } from '@/crypto/encoding';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const SSH_MSG_USERAUTH_SUCCESS = 52;
const MASK = new SubnetMask('255.255.255.0');
const NO_MODES = new Uint8Array([0]);
const NO_ECHO = new Uint8Array([53, 0, 0, 0, 0, 0]);

interface Lab { client: LinuxPC; linux: LinuxServer; cisco: CiscoRouter }

async function lab(sshdLines: readonly string[] = []): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'PC', 0, 0);
  const linux = new LinuxServer('linux-server', 'SRV', 0, 0);
  const cisco = new CiscoRouter('R1', 0, 0);
  const ports = sw.getPorts();
  [client.getPort('eth0')!, linux.getPort('eth0')!, cisco.getPorts()[0]].forEach((p, i) => new Cable(`c${i}`).connect(p, ports[i]));
  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  linux.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), MASK);
  for (const line of [
    'sudo systemctl start ssh', 'sudo useradd -m alice', 'echo "alice:secret" | sudo chpasswd',
    ...sshdLines.map((l) => `echo "${l}" | sudo tee -a /etc/ssh/sshd_config`),
    ...(sshdLines.length > 0 ? ['sudo systemctl reload ssh'] : []),
  ]) await linux.executeCommand(line);
  for (const c of ['enable', 'configure terminal', 'hostname R1',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret Cisco123', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048',
    'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'end']) await cisco.executeCommand(c);
  await settle();
  return { client, linux, cisco };
}

async function login(client: LinuxPC, ip: string, user: string, password: string): Promise<{
  connection: SshConnection; transport: SshTransport; authenticated: boolean;
}> {
  const socket = await (client as unknown as {
    tcpConnect(ip: string, port: number): Promise<TcpStream | null>;
  }).tcpConnect(ip, 22);
  expect(socket).toBeTruthy();
  const transport = new SshTransport(socket!, {
    role: 'client', identification: 'SSH-2.0-probe',
    algorithms: resolveAlgorithmDirectives({
      kex: '+diffie-hellman-group14-sha1', hostKey: '+ssh-rsa',
    }),
  });
  expect((await transport.established).ok).toBe(true);
  let authenticated = false;
  transport.onMessage((payload) => { if (payload[0] === SSH_MSG_USERAUTH_SUCCESS) authenticated = true; });
  transport.send(encodeUserauthRequest(user, { method: 'password', password }));
  await settle();
  return { connection: new SshConnection(transport), transport, authenticated };
}

interface Collected { stdout: string; stderr: string; status: number | null; closed: boolean; channel: ConnectionChannel }

function collect(channel: ConnectionChannel): Collected {
  const state: Collected = { stdout: '', stderr: '', status: null, closed: false, channel };
  channel.onData((d) => { state.stdout += bytesToUtf8(d); });
  channel.onExtendedData((type, d) => { if (type === 1) state.stderr += bytesToUtf8(d); });
  channel.onRequest((request) => { if (request.name === 'exit-status') state.status = decodeExitStatus(request.payload); });
  channel.onClose(() => { state.closed = true; });
  return state;
}

describe('canaux session RFC 4254 -- exec', () => {
  it('TEMOIN -- l\'authentification par mot de passe aboutit a USERAUTH_SUCCESS', async () => {
    const { client } = await lab();

    expect((await login(client, '10.0.0.2', 'alice', 'secret')).authenticated).toBe(true);
  });

  it('un canal session est confirme et `exec echo hello` rend hello, exit-status 0, puis CLOSE', async () => {
    const { client } = await lab();
    const { connection } = await login(client, '10.0.0.2', 'alice', 'secret');
    const channel = await connection.openChannel('session');
    const run = collect(channel);
    const accepted = await channel.request('exec', encodeStringPayload('echo hello'), true);
    await settle();

    expect(accepted).toBe(true);
    expect(run.stdout).toBe('hello\n');
    expect(run.status).toBe(0);
    expect(run.closed).toBe(true);
  });

  it('le code de sortie de la commande voyage dans exit-status', async () => {
    const { client } = await lab();
    const { connection } = await login(client, '10.0.0.2', 'alice', 'secret');
    const channel = await connection.openChannel('session');
    const run = collect(channel);
    await channel.request('exec', encodeStringPayload('ls /nonexistent-dir'), true);
    await settle();

    expect(run.stdout + run.stderr).toContain('No such file or directory');
    expect(run.status).toBe(2);
  });

  it('un second exec sur le meme canal est refuse', async () => {
    const { client } = await lab();
    const { connection } = await login(client, '10.0.0.2', 'alice', 'secret');
    const channel = await connection.openChannel('session');
    await channel.request('exec', encodeStringPayload('sleep 0'), true);

    expect(await channel.request('exec', encodeStringPayload('echo again'), true)).toBe(false);
  });

  it('un type de canal inconnu est refuse par OPEN_FAILURE 3', async () => {
    const { client } = await lab();
    const { connection } = await login(client, '10.0.0.2', 'alice', 'secret');

    await expect(connection.openChannel('x11')).rejects.toMatchObject({ reason: 3 });
  });

  it('MaxSessions 2 : le troisieme canal session est refuse (OPEN_FAILURE 1, « open failed »)', async () => {
    const { client } = await lab(['MaxSessions 2']);
    const { connection } = await login(client, '10.0.0.2', 'alice', 'secret');
    await connection.openChannel('session');
    await connection.openChannel('session');

    await expect(connection.openChannel('session')).rejects.toMatchObject({ reason: 1, description: 'open failed' });
  });

  it('keepalive@openssh.com recoit REQUEST_FAILURE et la connexion reste utilisable', async () => {
    const { client } = await lab();
    const { connection } = await login(client, '10.0.0.2', 'alice', 'secret');

    expect(await connection.globalRequest('keepalive@openssh.com')).toBeNull();
    const channel = await connection.openChannel('session');
    const run = collect(channel);
    await channel.request('exec', encodeStringPayload('echo alive'), true);
    await settle();
    expect(run.stdout).toBe('alive\n');
  });
});

describe('canaux session RFC 4254 -- pty-req et shell', () => {
  async function shell(client: LinuxPC, ip: string, user: string, password: string, modes: Uint8Array): Promise<Collected> {
    const { connection } = await login(client, ip, user, password);
    const channel = await connection.openChannel('session');
    const run = collect(channel);
    await channel.request('pty-req', encodePtyRequest({
      term: 'xterm', columns: 80, rows: 24, pixelWidth: 0, pixelHeight: 0, modes,
    }), true);
    expect(await channel.request('shell', undefined, true)).toBe(true);
    await settle();
    return run;
  }

  it('un shell Linux affiche son invite, execute une ligne et en reaffiche une', async () => {
    const { client } = await lab();
    const run = await shell(client, '10.0.0.2', 'alice', 'secret', NO_ECHO);
    run.channel.write('whoami\n');
    await settle();

    expect(run.stdout).toContain('alice@');
    expect(run.stdout).toContain('alice\r\n');
    expect(run.stdout.split('alice@').length).toBeGreaterThan(2);
  });

  it('le shell d\'un routeur Cisco rend son invite R1# et la sortie de show clock', async () => {
    const { client } = await lab();
    const run = await shell(client, '10.0.0.1', 'admin', 'Cisco123', NO_ECHO);
    run.channel.write('show clock\n');
    await settle();

    expect(run.stdout).toContain('R1#');
    expect(run.stdout).toMatch(/UTC .* \d{4}\r\n/);
  });

  it('ECHO active (le defaut d\'un pty) : le serveur renvoie les caracteres tapes', async () => {
    const { client } = await lab();
    const run = await shell(client, '10.0.0.1', 'admin', 'Cisco123', NO_MODES);
    run.channel.write('show clock\n');
    await settle();

    expect(run.stdout).toContain('R1#show clock\r\n');
  });

  it('`exit` ferme la session : exit-status, EOF puis CLOSE', async () => {
    const { client } = await lab();
    const run = await shell(client, '10.0.0.1', 'admin', 'Cisco123', NO_ECHO);
    run.channel.write('exit\n');
    await settle();

    expect(run.status).toBe(0);
    expect(run.closed).toBe(true);
  });

  it('la fin de l\'entree (EOF) ferme le shell comme le fait sshd', async () => {
    const { client } = await lab();
    const run = await shell(client, '10.0.0.1', 'admin', 'Cisco123', NO_ECHO);
    run.channel.eof();
    await settle();

    expect(run.closed).toBe(true);
  });

  it('sans pty, les fins de ligne restent des LF', async () => {
    const { client } = await lab();
    const { connection } = await login(client, '10.0.0.1', 'admin', 'Cisco123');
    const channel = await connection.openChannel('session');
    const run = collect(channel);
    await channel.request('shell', undefined, true);
    channel.write('show clock\n');
    await settle();

    expect(run.stdout).toMatch(/UTC .* \d{4}\nR1#/);
    expect(run.stdout).not.toContain('\r\n');
  });
});
