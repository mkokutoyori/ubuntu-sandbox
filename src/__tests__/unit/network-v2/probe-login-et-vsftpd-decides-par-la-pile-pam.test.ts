/**
 * telnetd (login(1), service /etc/pam.d/login) et vsftpd (service nomme par pam_service_name,
 * /etc/pam.d/vsftpd de l'Ubuntu 22.04) laissent la pile PAM decider : pam_nologin, pam_listfile
 * sur /etc/ftpusers, pam_shells, pam_unix auth et compte. Le journal vient des modules
 * (`pam_unix(login:auth): authentication failure; ... tty=/dev/pts/0 ... rhost=10.0.0.10`).
 *
 * MESURE DE DEPART, serveur Linux + client (telnet reel sur le fil, curl ftp://) :
 *  - les deux appelaient userMgr.checkPassword (le compteur de refus du gestionnaire de comptes) :
 *    /etc/nologin ne refusait personne en telnet, un compte expire ouvrait une session, aucune
 *    ligne pam_unix(login:...) ;
 *  - `pam_service_name` etait dans la liste des directives « inoffensives » : lue, jamais evaluee ;
 *  - /etc/pam.d/vsftpd et /etc/ftpusers n'existaient pas : un `auth required pam_deny.so` ou un
 *    nom dans /etc/ftpusers n'avait aucun effet.
 * Discriminee contre l'etat d'avant (`git stash push -- src/network src/shell src/terminal`) : 8 des
 * 10 cas tombent. Temoins (verts avant et apres) : « le bon mot de passe ouvre une session telnet » et « le bon
 * mot de passe ouvre une session FTP locale », qui prouvent le labo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { TelnetClientSession } from '@/network/protocols/telnet/TelnetClientSession';
import type { TelnetClientTransport } from '@/network/protocols/telnet/TelnetClientSession';
import '../new_firewall/fortigateBatteryHarness';

const MASK = new SubnetMask('255.255.255.0');
const SERVER_IP = '10.0.0.20';

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildLan(): Promise<{ client: LinuxPC; server: LinuxServer; authLog: () => Promise<string> }> {
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('cab').connect(client.getPort('eth0')!, server.getPort('eth0')!);
  await server.executeCommand('useradd -m -s /bin/bash alice');
  await server.executeCommand('echo alice:alicesecret | chpasswd');
  await server.executeCommand('systemctl start telnet');
  return { client, server, authLog: async () => String(await server.executeCommand('cat /var/log/auth.log')) };
}

async function openTelnet(client: LinuxPC): Promise<TelnetClientSession> {
  const socket = await (client as unknown as {
    tcpConnect(h: string, p: number): Promise<TelnetClientTransport | null>;
  }).tcpConnect(SERVER_IP, 23);
  return new TelnetClientSession(socket!);
}

async function login(client: LinuxPC, password: string, user = 'alice'): Promise<string> {
  const session = await openTelnet(client);
  await settle();
  session.drain();
  session.send(user);
  await settle();
  session.send(password);
  await settle();
  const out = session.drain();
  return out;
}

async function ftpLab(): Promise<{ client: LinuxPC; server: LinuxServer; authLog: () => Promise<string> }> {
  const lab = await buildLan();
  await lab.server.executeCommand('apt install -y vsftpd');
  await lab.server.executeCommand("sed -i 's/^#local_enable=YES/local_enable=YES/' /etc/vsftpd.conf");
  await lab.server.executeCommand('systemctl restart vsftpd');
  return lab;
}

const ftp = (client: LinuxPC, password: string, user = 'alice') =>
  client.executeCommand(`curl -sS -u ${user}:${password} ftp://${SERVER_IP}/; echo EC=$?`);

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('login (telnetd) decided by the PAM stack', () => {
  it('the right password opens a telnet session — WITNESS', async () => {
    const { client } = await buildLan();
    const session = await openTelnet(client);
    await settle();
    session.drain();
    session.send('alice');
    await settle();
    session.send('alicesecret');
    await settle();
    session.drain();
    session.send('whoami');
    await settle();
    expect(session.drain()).toContain('alice');
  });

  it('a wrong password is logged by pam_unix(login:auth) with the pty and the client address', async () => {
    const { client, authLog } = await buildLan();
    expect(await login(client, 'WRONG')).toContain('Login incorrect');
    expect(await authLog()).toMatch(
      /login\[\d+\]: pam_unix\(login:auth\): authentication failure; logname= uid=0 euid=0 tty=\/dev\/pts\/\d+ ruser= rhost=10\.0\.0\.10 {2}user=alice/);
  });

  it('/etc/nologin refuses a non-root user at the auth phase (pam_nologin)', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('echo "closed for maintenance" > /etc/nologin');
    expect(await login(client, 'alicesecret')).toContain('Login incorrect');
  });

  it('an expired account is refused by the account phase', async () => {
    const { client, server, authLog } = await buildLan();
    await server.executeCommand('chage -E 0 alice');
    expect(await login(client, 'alicesecret')).toContain('Login incorrect');
    expect(await authLog()).toContain('pam_unix(login:account): account alice has expired (account expired)');
  });

  it('an auth line required pam_deny.so in /etc/pam.d/login refuses everyone', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand("sed -i '1i auth requisite pam_deny.so' /etc/pam.d/login");
    expect(await login(client, 'alicesecret')).toContain('Login incorrect');
  });
});

describe('vsftpd decided by the PAM stack', () => {
  it('the right password opens a local FTP session — WITNESS', async () => {
    const { client } = await ftpLab();
    expect(await ftp(client, 'alicesecret')).toContain('EC=0');
  });

  it('a wrong password is refused and logged by pam_unix(vsftpd:auth)', async () => {
    const { client, authLog } = await ftpLab();
    expect(await ftp(client, 'WRONG')).toContain('curl: (67) Access denied: 530');
    expect(await authLog()).toMatch(/vsftpd\[\d+\]: pam_unix\(vsftpd:auth\): authentication failure; logname= uid=0 euid=0 tty=ftp ruser= rhost= {2}user=alice/);
  });

  it('a name listed in /etc/ftpusers is refused by pam_listfile even with the right password', async () => {
    const { client, server } = await ftpLab();
    await server.executeCommand('echo alice >> /etc/ftpusers');
    expect(await ftp(client, 'alicesecret')).toContain('curl: (67) Access denied: 530');
  });

  it('pam_service_name chooses the stack: a pam_deny stack named by the directive refuses', async () => {
    const { client, server } = await ftpLab();
    await server.executeCommand('echo "auth required pam_deny.so" > /etc/pam.d/ftpgate');
    await server.executeCommand('echo "account required pam_permit.so" >> /etc/pam.d/ftpgate');
    await server.executeCommand("sed -i 's/^pam_service_name=vsftpd/pam_service_name=ftpgate/' /etc/vsftpd.conf");
    await server.executeCommand('systemctl restart vsftpd');
    expect(await ftp(client, 'alicesecret')).toContain('curl: (67) Access denied: 530');
  });

  it('an expired account is refused by the account phase', async () => {
    const { client, server } = await ftpLab();
    await server.executeCommand('chage -E 0 alice');
    expect(await ftp(client, 'alicesecret')).toContain('curl: (67) Access denied: 530');
  });
});
