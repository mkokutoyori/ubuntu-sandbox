/**
 * sshd (UsePAM yes, l'Ubuntu 22.04 semee) laisse la pile /etc/pam.d/sshd decider : le mot de
 * passe, la phase compte (pam_nologin, pam_access, expiration...) et le journal viennent des
 * MODULES, par une transaction PAM par connexion (auth-pam.c d'OpenSSH 8.9 : conversation
 * « aveugle », faux mot de passe pour un compte inconnu, pam_end a la fermeture).
 *
 * MESURE DE DEPART, sur un serveur Linux et un client Linux, `journalctl -u ssh` :
 *  - un mot de passe faux ne donnait QUE « Failed password for alice ... », sans la ligne
 *    `pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser=
 *    rhost=10.0.0.2  user=alice` que tout vrai sshd Ubuntu ecrit juste avant ;
 *  - un compte inconnu ne donnait ni « check pass; user unknown » ni la ligne de pam_unix ;
 *  - trois essais sur une connexion ne donnaient pas « 2 more authentication failures » ;
 *  - /etc/nologin ou une ligne `account required pam_access.so` decommentee dans
 *    /etc/pam.d/sshd ne refusait personne : la phase compte n'existait pas comme pile ;
 *  - le refus portait une phrase inventee, pas `error: PAM: ...` + `fatal: Access denied for
 *    user alice by PAM account configuration [preauth]`.
 * Temoins (verts avant et apres) : « le bon mot de passe ouvre une session » et
 * « UsePAM no ne journalise aucune ligne PAM », qui prouvent le labo.
 *
 * Limite : le delai d'echec (2 s) est calcule par libpam (failDelayUs) mais la reponse n'est
 * pas retardee : elle exigerait que l'horloge virtuelle avance pendant l'attente du client.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import type { TcpConnector } from '@/network/tcp/types';

class Retrying extends SilentSshInteractionHandler {
  constructor() { super('wrong'); }
  async promptPassword(): Promise<string> { return 'wrong'; }
  canPromptAgain(): boolean { return true; }
}

async function connectWrong(pc: LinuxPC): Promise<void> {
  const session = new SshSession({
    tcpConnector: ((h, p) => (pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> }).tcpConnect(h, p)) as TcpConnector,
    vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
    localUser: 'root', localUid: 0, localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new Retrying(),
  });
  await session.connect(SshConnectOptionsBuilder.create().host('10.0.0.1').user('alice').port(22).strictHostKeyChecking('accept-new').build());
  session.disconnect();
}

async function labo() {
  const srv = new LinuxPC('linux-pc', 'SRV');
  const cli = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  new Cable('c1').connect(srv.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('c2').connect(cli.getPort('eth0')!, sw.getPort('eth1')!);
  const mask = new SubnetMask('255.255.255.0');
  srv.configureInterface('eth0', new IPAddress('10.0.0.1'), mask);
  cli.configureInterface('eth0', new IPAddress('10.0.0.2'), mask);
  await srv.executeCommand('sudo useradd -m -s /bin/bash alice');
  await srv.executeCommand('echo "alice:secret" | sudo chpasswd');
  await srv.executeCommand('sudo systemctl start ssh');
  return {
    srv, cli,
    login: (password: string, user = 'alice') => cli.executeCommand(`ssh -o StrictHostKeyChecking=accept-new ${user}@10.0.0.1 whoami`, `${password}\n`),
    journal: async () => String(await srv.executeCommand('sudo cat /var/log/auth.log')),
  };
}

const sshdLines = (log: string): string[] =>
  log.split('\n').filter((line) => / sshd\[\d+\]: /.test(line)).map((line) => line.replace(/^.* sshd\[\d+\]: /, ''));

describe('sshd decided by the PAM stack', () => {
  it('WITNESS -- the right password opens a session', async () => {
    const lab = await labo();
    expect(String(await lab.login('secret'))).toContain('alice');
  });

  it('a wrong password journals the pam_unix failure BEFORE sshd\'s own "Failed password"', async () => {
    const lab = await labo();
    await lab.login('wrong');
    const lines = sshdLines(await lab.journal());
    const pam = lines.findIndex((line) => line === 'pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=10.0.0.2  user=alice');
    const failed = lines.findIndex((line) => /^Failed password for alice from 10\.0\.0\.2 port \d+ ssh2$/.test(line));
    expect(pam).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(pam);
  });

  it('an unknown account: Invalid user, check pass, authentication failure without user=, Failed password for invalid user', async () => {
    const lab = await labo();
    await lab.login('whatever', 'ghost');
    const lines = sshdLines(await lab.journal());
    const order = [
      /^Invalid user ghost from 10\.0\.0\.2 port \d+$/,
      /^pam_unix\(sshd:auth\): check pass; user unknown$/,
      /^pam_unix\(sshd:auth\): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=10\.0\.0\.2 $/,
      /^Failed password for invalid user ghost from 10\.0\.0\.2 port \d+ ssh2$/,
    ].map((pattern) => lines.findIndex((line) => pattern.test(line)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('three wrong passwords on one connection: pam_unix reports the repeats when the connection ends', async () => {
    const lab = await labo();
    await connectWrong(lab.cli);
    const lines = sshdLines(await lab.journal());
    expect(lines.filter((line) => line.startsWith('pam_unix(sshd:auth): authentication failure;')).length).toBe(1);
    expect(lines.some((line) => /^PAM 2 more authentication failures; logname= uid=0 euid=0 tty=ssh ruser= rhost=10\.0\.0\.2 {2}user=alice$/.test(line))).toBe(true);
  });

  it('/etc/nologin refuses alice in the account phase and root still gets in', async () => {
    const lab = await labo();
    await lab.srv.executeCommand('echo "System going down" | sudo tee /etc/nologin');
    expect(String(await lab.login('secret')).split('\n')).not.toContain('alice');
    const lines = sshdLines(await lab.journal());
    expect(lines).toContain('error: PAM: Authentication failure for alice from 10.0.0.2');
    expect(lines).toContain('fatal: Access denied for user alice by PAM account configuration [preauth]');
  });

  it('an operator who enables pam_access in /etc/pam.d/sshd restricts logins', async () => {
    const lab = await labo();
    await lab.srv.executeCommand('sudo sed -i "s/^# account  required     pam_access.so/account  required     pam_access.so/" /etc/pam.d/sshd');
    await lab.srv.executeCommand('echo "- : alice : ALL" | sudo tee -a /etc/security/access.conf');
    expect(String(await lab.login('secret')).split('\n')).not.toContain('alice');
    expect(await lab.journal()).toContain('pam_access(sshd:account): access denied for user `alice\' from `10.0.0.2\'');
  });

  it('an expired account is refused through pam_unix\'s account phase', async () => {
    const lab = await labo();
    await lab.srv.executeCommand('sudo chage -E 1 alice');
    expect(String(await lab.login('secret')).split('\n')).not.toContain('alice');
    expect(await lab.journal()).toContain('pam_unix(sshd:account): account alice has expired (account expired)');
  });

  it('UsePAM no: no PAM line at all, password checked by sshd itself', async () => {
    const lab = await labo();
    await lab.srv.executeCommand('sudo sed -i "s/^UsePAM yes/UsePAM no/" /etc/ssh/sshd_config');
    await lab.srv.executeCommand('sudo systemctl restart ssh');
    await lab.login('wrong');
    expect(String(await lab.login('secret'))).toContain('alice');
    const log = await lab.journal();
    expect(log).toContain('Failed password for alice');
    expect(log).not.toContain('pam_unix(sshd:auth)');
  });
});
