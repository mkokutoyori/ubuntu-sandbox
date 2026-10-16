/*
 * sshd et ssh authentifient par certificat utilisateur comme OpenSSH 8.9p1.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `auth2-pubkey.c` : `user_cert_trusted_ca` (TrustedUser
 *   CAKeys) et `check_authkey_line` (lignes `cert-authority` de
 *   authorized_keys) acceptent un certificat dont l'AC est connue ;
 *   `sshkey_cert_check_authority` refuse « Certificate invalid: expired »,
 *   « … not yet valid », « … name is not a listed principal », « Certificate
 *   lacks principal list » ; AuthorizedPrincipalsFile remplace la
 *   comparaison avec le nom d'utilisateur (« Certificate does not contain
 *   an authorized principal ») ; `auth-options.c` (`cert_option_list`)
 *   traduit force-command et source-address en options de session, refuse
 *   une option critique inconnue (« Certificate critical option "x" is not
 *   supported ») ; `auth_authorise_keyopts` refuse une adresse hors
 *   source-address ; RevokedKeys refuse le certificat dont la cle ou l'AC
 *   est listee ; CASignatureAlgorithms borne l'algorithme de signature de
 *   l'AC ;
 * - `auth.c` (`format_method_key`) : le journal ecrit « Accepted publickey
 *   for <u> from <ip> port <p> ssh2: ED25519-CERT SHA256:<empreinte du
 *   certificat> ID <id> (serial <n>) CA ED25519 SHA256:<empreinte AC> » ;
 *   `auth2-pubkey.c` verbose « Accepted certificate ID "<id>" (serial <n>)
 *   signed by <TYPE> CA <empreinte> via <fichier> » ;
 * - `sshconnect2.c` : le client propose <identite>-cert.pub avec la cle de
 *   l'identite.
 *
 * Ecrite contre ces sources, avant l'implantation. 14 des 17 cas tombent
 * avant elle (le certificat n'etait pas reconnu). Passent des deux cotes le
 * TEMOIN de la cle simple, le refus sans AC de confiance et le refus par
 * CASignatureAlgorithms moins son journal (le refus y est celui de tout
 * certificat inconnu).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab {
  readonly pc: LinuxPC;
  readonly srv: LinuxServer;
}

async function buildLab(sshdDirectives: readonly string[] = []): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await srv.executeCommand('useradd -m -s /bin/bash alice');
  await srv.executeCommand("echo 'alice:admin' | chpasswd");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C ca@lab -f ~/ca");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C alice@lab -f ~/id");
  const caLine = (await pc.executeCommand('cat ~/ca.pub')).trim();
  await srv.executeCommand(`printf '%s\\n' '${caLine}' > /etc/ssh/ca.pub`);
  for (const directive of sshdDirectives) await srv.executeCommand(`printf '%s\\n' '${directive}' >> /etc/ssh/sshd_config`);
  await srv.executeCommand('systemctl restart ssh');
  return { pc, srv };
}

const TRUST = 'TrustedUserCAKeys /etc/ssh/ca.pub';
const SSH = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id alice@10.0.0.2';

async function certify(lab: Lab, options: string): Promise<string> {
  return lab.pc.executeCommand(`ssh-keygen -s ~/ca -I alice-key -z 7 ${options} ~/id.pub`);
}

async function authLog(lab: Lab): Promise<string> {
  return lab.srv.executeCommand('cat /var/log/auth.log');
}

describe('certificats utilisateur', () => {
  it('TEMOIN: une cle simple dans authorized_keys ouvre une session', async () => {
    const lab = await buildLab();
    const publicKey = (await lab.pc.executeCommand('cat ~/id.pub')).trim();
    await lab.srv.executeCommand(`mkdir -p /home/alice/.ssh && printf '%s\\n' '${publicKey}' > /home/alice/.ssh/authorized_keys && chown -R alice:alice /home/alice/.ssh && chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys`);

    expect((await lab.pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('une AC de confiance et le bon principal ouvrent la session, le journal decrit le certificat', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice');

    expect((await lab.pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
    const log = await authLog(lab);
    expect(log).toMatch(/Accepted publickey for alice from 10\.0\.0\.1 port \d+ ssh2: ED25519-CERT SHA256:[A-Za-z0-9+/]{43} ID alice-key \(serial 7\) CA ED25519 SHA256:[A-Za-z0-9+/]{43}/);
  }, 120_000);

  it('le journal verbose dit l\'AC et le fichier de confiance', async () => {
    const lab = await buildLab([TRUST, 'LogLevel VERBOSE']);
    await certify(lab, '-n alice');
    await lab.pc.executeCommand(`${SSH} whoami`);

    expect(await authLog(lab)).toMatch(/Accepted certificate ID "alice-key" \(serial 7\) signed by ED25519 CA SHA256:[A-Za-z0-9+/]{43} via \/etc\/ssh\/ca\.pub/);
  }, 120_000);

  it('sans AC de confiance, le certificat est refuse', async () => {
    const lab = await buildLab();
    await certify(lab, '-n alice');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
  }, 120_000);

  it('un autre principal est refuse', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n bob');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('error: Certificate invalid: name is not a listed principal');
  }, 120_000);

  it('un certificat sans principal est refuse', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('error: Certificate lacks principal list');
  }, 120_000);

  it('un certificat expire est refuse', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -V 20200101:20210101');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('error: Certificate invalid: expired');
  }, 120_000);

  it('un certificat pas encore valide est refuse', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -V 20990101:forever');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('error: Certificate invalid: not yet valid');
  }, 120_000);

  it('AuthorizedPrincipalsFile remplace la comparaison avec le nom', async () => {
    const lab = await buildLab([TRUST, 'AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u']);
    await lab.srv.executeCommand("mkdir -p /etc/ssh/auth_principals && printf 'deploy\\n' > /etc/ssh/auth_principals/alice");

    await certify(lab, '-n alice');
    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('error: Certificate does not contain an authorized principal');

    await certify(lab, '-n deploy');
    expect((await lab.pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('force-command du certificat remplace la commande demandee', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -O force-command=id');

    const out = await lab.pc.executeCommand(`${SSH} whoami`);
    expect(out).toMatch(/uid=\d+\(alice\)/);
  }, 120_000);

  it('source-address exclut une autre adresse', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -O source-address=192.168.99.0/24');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('Authentication tried for alice with valid certificate but not from a permitted source address (10.0.0.1).');
  }, 120_000);

  it('source-address contenant l\'adresse laisse passer', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -O source-address=10.0.0.0/24');

    expect((await lab.pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('une option critique inconnue est refusee', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -O critical:surprise=1');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('error: Certificate critical option "surprise" is not supported');
  }, 120_000);

  it('une ligne cert-authority d\'authorized_keys suffit', async () => {
    const lab = await buildLab();
    await certify(lab, '-n alice');
    const caLine = (await lab.pc.executeCommand('cut -d" " -f1,2 ~/ca.pub')).trim();
    await lab.srv.executeCommand(`mkdir -p /home/alice/.ssh && printf 'cert-authority %s\\n' '${caLine}' > /home/alice/.ssh/authorized_keys && chown -R alice:alice /home/alice/.ssh && chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys`);

    expect((await lab.pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('RevokedKeys refuse un certificat dont la cle est listee', async () => {
    const lab = await buildLab([TRUST, 'RevokedKeys /etc/ssh/revoked']);
    await certify(lab, '-n alice');
    const publicKey = (await lab.pc.executeCommand('cut -d" " -f1,2 ~/id.pub')).trim();
    await lab.srv.executeCommand(`printf '%s\\n' '${publicKey}' > /etc/ssh/revoked`);

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toMatch(/error: Authentication key ED25519 SHA256:[A-Za-z0-9+/]{43} revoked by file \/etc\/ssh\/revoked/);
  }, 120_000);

  it('CASignatureAlgorithms borne l\'algorithme de signature de l\'AC', async () => {
    const allowed = await buildLab([TRUST, 'CASignatureAlgorithms ssh-ed25519,rsa-sha2-512']);
    await certify(allowed, '-n alice');
    expect((await allowed.pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('CASignatureAlgorithms sans ssh-ed25519 refuse une AC Ed25519', async () => {
    const lab = await buildLab([TRUST, 'CASignatureAlgorithms rsa-sha2-512']);
    await certify(lab, '-n alice');

    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('certificate signature algorithm ssh-ed25519: signature algorithm not supported');
  }, 120_000);
});
