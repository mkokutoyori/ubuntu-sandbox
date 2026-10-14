/**
 * Sonde — les piles PAM et la configuration de securite d'une machine Linux
 * sont celles d'Ubuntu 22.04, et la phase session du service `login`
 * traverse la pile.
 *
 * AUTORITE : les paquets `jammy` eux-memes (archive.ubuntu.com) —
 * `libpam-modules 1.4.0-11ubuntu2`, `login 4.8.1-2ubuntu2`, `util-linux
 * 2.37.2-4ubuntu3`, `sudo 1.9.9-1ubuntu2`, `cron 3.0pl1-137ubuntu3`,
 * `passwd 4.8.1-2ubuntu2`, `openssh-server 8.9p1-3` ; les `common-*` sont
 * ce que `pam-auth-update` de `libpam-runtime 1.4.0-11ubuntu2` genere pour
 * les profils `unix`, `systemd` et `capability`. Les empreintes SHA-256
 * ci-dessous sont celles de ces fichiers. Le comportement de `pam_lastlog`
 * est celui de `modules/pam_lastlog/pam_lastlog.c` (linux-pam v1.4.0, la
 * version d'Ubuntu 22.04).
 *
 * Mesure de depart (fichiers ecrits de memoire, session `login` hors pile) :
 *
 *   - 15 des 20 fichiers mesures differaient du paquet ; `runuser`,
 *     `runuser-l`, `sudo-i`, `newusers`, `namespace.conf`, `namespace.init` et
 *     `sepermit.conf` n'existaient pas ;
 *   - `common-session` portait le commentaire de `common-session-
 *     noninteractive` ;
 *   - une connexion telnet n'ouvrait aucune session PAM : ni `Last login`, ni
 *     enregistrement dans lastlog, ni ligne `pam_unix(login:session)`.
 *
 * Discriminee par `git stash push -- src/network src/terminal src/shell` :
 * 15 des 19 cas tombent avant. Les 4 autres passent des deux cotes et sont
 * nommes : `silent` et `noupdate` (avant, il n'y avait pas de `Last login`
 * du tout, donc l'absence est acquise ; le cas « premiere / seconde
 * connexion » est leur temoin positif dans le meme laboratoire), le mauvais
 * mot de passe (TEMOIN : l'authentification n'a pas bouge) et le message du
 * jour de l'operateur (TEMOIN : `pam_motd` le lit a la place de la lecture
 * directe, une seule fois).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { TelnetClientSession, type TelnetClientTransport } from '@/network/protocols/telnet/TelnetClientSession';

const MASK = new SubnetMask('255.255.255.0');
const SERVER_IP = '10.0.0.20';
const CLIENT_IP = '10.0.0.10';

const JAMMY_SHA256: Readonly<Record<string, string>> = {
  '/etc/pam.d/login': '7cfc173a991eddae9552cecf578c6f5044f9d70d5640c45036027b02aa135b57',
  '/etc/pam.d/su': 'fda16622dc6198eae5d6ae522bb820b7b68dbf2e73899295c4cac9744f7c7904',
  '/etc/pam.d/sudo': '237bd06ddff88d0ab7735346ef15d412fdd121f5c07ab3c4f04a4a620acec158',
  '/etc/pam.d/runuser': '2d430cb6628248953568010427d663f3305856f3cb055955c2239bea226c5280',
  '/etc/pam.d/cron': '50a7062347b76fe4a429065547f2b53ffe49ac7d896f6b238010a3ee90446a84',
  '/etc/pam.d/newusers': '26e75ce7c9066801b8db380ff9d8ba58a5e8cf2de5fb38ffd1db5ba62c85acef',
  '/etc/security/limits.conf': 'efe8446a3c499818e7c5736c9494f222cb9098e8733aee91508b3631ad053b27',
  '/etc/security/faillock.conf': '5c8c902912f0bb59f86b86517f2127ea0c57c5d05b17c4aa62f5bc06c7043c78',
  '/etc/security/pam_env.conf': '7038e2676178dcda6a9bdd6b8948af8206af56f5291cb2cda7f563a9904c15bd',
  '/etc/pam.d/common-session': 'f237c090d61f72820ede6f77f4889e9db292b84fafb2c5d19ae6c125ea3bd371',
};

type Executor = { vfs: { readFile(p: string): string | null; exists(p: string): boolean; writeFile(p: string, c: string, a: number, b: number, m: number): void } };

const executorOf = (machine: LinuxServer): Executor => (machine as unknown as { executor: Executor }).executor;

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function lab(): Promise<{ client: LinuxPC; server: LinuxServer }> {
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  client.getPort('eth0')!.configureIP(new IPAddress(CLIENT_IP), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('cab').connect(client.getPort('eth0')!, server.getPort('eth0')!);
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alicesecret');
  await server.executeCommand('systemctl start telnet');
  return { client, server };
}

async function telnetLogin(client: LinuxPC, password = 'alicesecret'): Promise<{ screen: string; session: TelnetClientSession }> {
  const socket = await (client as unknown as {
    tcpConnect(h: string, p: number): Promise<TelnetClientTransport | null>;
  }).tcpConnect(SERVER_IP, 23);
  const session = new TelnetClientSession(socket!);
  await settle();
  session.drain();
  session.send('alice');
  await settle();
  session.send(password);
  await settle();
  return { screen: session.drain(), session };
}

async function logout(session: TelnetClientSession): Promise<void> {
  session.send('exit');
  await settle();
  session.drain();
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('les fichiers sont ceux des paquets Ubuntu 22.04', () => {
  for (const [path, digest] of Object.entries(JAMMY_SHA256)) {
    it(`${path}`, async () => {
      const { server } = await lab();
      const content = executorOf(server).vfs.readFile(path);
      expect(content, `${path} absent`).not.toBeNull();
      expect(createHash('sha256').update(content ?? '').digest('hex')).toBe(digest);
    });
  }

  it('les piles que Ubuntu livre et que nous n\'avions pas existent', async () => {
    const { server } = await lab();
    const vfs = executorOf(server).vfs;
    for (const path of ['/etc/pam.d/runuser', '/etc/pam.d/runuser-l', '/etc/pam.d/sudo-i', '/etc/pam.d/newusers',
      '/etc/security/namespace.conf', '/etc/security/namespace.init', '/etc/security/sepermit.conf']) {
      expect(vfs.exists(path), path).toBe(true);
    }
  });
});

describe('la phase session du service login traverse la pile', () => {
  it('la premiere connexion n\'a pas de `Last login`, la seconde en a un avec l\'hote et le terminal', async () => {
    const { client } = await lab();
    const first = await telnetLogin(client);
    expect(first.screen).not.toMatch(/Last login/);
    await logout(first.session);
    const second = await telnetLogin(client);
    expect(second.screen).toMatch(new RegExp(`Last login: \\w{3} \\w{3} [ \\d]\\d \\d\\d:\\d\\d:\\d\\d \\w+ \\d{4} from ${CLIENT_IP} on pts/\\d+`));
  });

  it('la connexion est inscrite dans lastlog', async () => {
    const { client, server } = await lab();
    const login = await telnetLogin(client);
    expect(login.screen).toMatch(/\$ $/);
    expect(await server.executeCommand('lastlog -u alice')).toContain(CLIENT_IP);
  });

  it('auth.log porte la ligne pam_unix de la session ouverte par LOGIN', async () => {
    const { client, server } = await lab();
    await telnetLogin(client);
    expect(await server.executeCommand('sudo cat /var/log/auth.log'))
      .toMatch(/pam_unix\(login:session\): session opened for user alice\(uid=1000\) by LOGIN\(uid=0\)/);
  });

  it('`pam_lastlog.so silent` dans la pile supprime l\'annonce : l\'option est evaluee', async () => {
    const { client, server } = await lab();
    const vfs = executorOf(server).vfs;
    const stack = (vfs.readFile('/etc/pam.d/login') ?? '').replace(/^session\s+optional\s+pam_lastlog\.so.*$/m, 'session optional pam_lastlog.so silent');
    vfs.writeFile('/etc/pam.d/login', stack, 0, 0, 0o022);
    await logout((await telnetLogin(client)).session);
    expect((await telnetLogin(client)).screen).not.toMatch(/Last login/);
  });

  it('`pam_lastlog.so never` souhaite la bienvenue a un compte neuf', async () => {
    const { client, server } = await lab();
    const vfs = executorOf(server).vfs;
    const stack = (vfs.readFile('/etc/pam.d/login') ?? '').replace(/^session\s+optional\s+pam_lastlog\.so.*$/m, 'session optional pam_lastlog.so never');
    vfs.writeFile('/etc/pam.d/login', stack, 0, 0, 0o022);
    expect((await telnetLogin(client)).screen).toContain('Welcome to your new account!');
  });

  it('`noupdate` n\'ecrit rien : la seconde connexion n\'a toujours pas de `Last login`', async () => {
    const { client, server } = await lab();
    const vfs = executorOf(server).vfs;
    const stack = (vfs.readFile('/etc/pam.d/login') ?? '').replace(/^session\s+optional\s+pam_lastlog\.so.*$/m, 'session optional pam_lastlog.so noupdate');
    vfs.writeFile('/etc/pam.d/login', stack, 0, 0, 0o022);
    await logout((await telnetLogin(client)).session);
    expect((await telnetLogin(client)).screen).not.toMatch(/Last login/);
  });

  it('TEMOIN : un mauvais mot de passe n\'ouvre pas de session', async () => {
    const { client } = await lab();
    const attempt = await telnetLogin(client, 'wrong');
    expect(attempt.screen).toContain('Login incorrect');
    expect(attempt.screen).not.toMatch(/Last login/);
  });

  it('TEMOIN : le message du jour de l\'operateur est affiche une seule fois', async () => {
    const { client, server } = await lab();
    executorOf(server).vfs.writeFile('/etc/motd', 'Bienvenue sur SERVER\n', 0, 0, 0o022);
    const login = await telnetLogin(client);
    expect(login.screen.split('Bienvenue sur SERVER').length - 1).toBe(1);
  });
});
