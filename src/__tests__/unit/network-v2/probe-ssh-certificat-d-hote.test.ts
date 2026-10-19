/*
 * Certificats d'hote : sshd les presente, ssh les verifie comme OpenSSH 8.9p1.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `PROTOCOL.certkeys` et `sshd_config(5)` : HostCertificate
 *   fait presenter a sshd un certificat d'hote (type 2) a la place de la cle
 *   nue ; la signature de l'echange porte l'algorithme de la cle sous-jacente
 *   (ssh-ed25519, rsa-sha2-512) alors que l'algorithme negocie est
 *   « …-cert-v01@openssh.com » ; le client les propose par defaut avant les
 *   cles nues ;
 * - `sshconnect.c` (`verify_host_key_callback`, `check_host_key`) : un
 *   certificat est accepte quand une ligne « @cert-authority <motifs> <cle> »
 *   de known_hosts designe l'AC et nomme l'hote, et que
 *   `sshkey_cert_check_host` l'admet : « Certificate invalid: not a host
 *   certificate / expired / not yet valid / name is not a listed principal »,
 *   « Certificate for <h> contains unsupported critical options(s) » ; il
 *   n'ecrit rien dans known_hosts ; sinon (« No matching CA found. Retry
 *   with plain key ») le client retombe sur la cle nue du certificat, avec
 *   StrictHostKeyChecking ;
 * - `ssh-keygen.c` : « -s ca -h -I id -n hote » signe la cle d'hote.
 *
 * Ecrite contre ces sources, avant l'implantation. 6 des 10 cas tombent
 * avant elle. Passent des deux cotes le TEMOIN sans certificat, les refus
 * avec StrictHostKeyChecking=yes qui viennent d'une AC qui ne convient pas
 * a l'hote ou d'un certificat utilisateur (la cle nue est inconnue de toute
 * facon) et la retombee sur la cle nue en accept-new.
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

const HOST_KEY = '/etc/ssh/ssh_host_ed25519_key';
const SSH = (strict: string) => `ssh -o BatchMode=yes -o StrictHostKeyChecking=${strict} -i ~/id alice@10.0.0.2`;

async function buildLab(certificate: string | null): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await srv.executeCommand('useradd -m -s /bin/bash alice');
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/id");
  const publicKey = (await pc.executeCommand('cat ~/id.pub')).trim();
  await srv.executeCommand(`mkdir -p /home/alice/.ssh && printf '%s\\n' '${publicKey}' > /home/alice/.ssh/authorized_keys && chown -R alice:alice /home/alice/.ssh && chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys`);
  await srv.executeCommand("ssh-keygen -q -t ed25519 -N '' -f /root/ca");
  if (certificate !== null) {
    await srv.executeCommand(`ssh-keygen -s /root/ca ${certificate} ${HOST_KEY}.pub`);
    await srv.executeCommand(`printf 'HostCertificate ${HOST_KEY}-cert.pub\\n' >> /etc/ssh/sshd_config`);
  }
  await srv.executeCommand('systemctl restart ssh');
  return { pc, srv };
}

async function trustCa(lab: Lab, hosts: string): Promise<void> {
  const authority = (await lab.srv.executeCommand('cut -d" " -f1,2 /root/ca.pub')).trim();
  await lab.pc.executeCommand(`mkdir -p ~/.ssh && printf '@cert-authority ${hosts} %s\\n' '${authority}' > ~/.ssh/known_hosts`);
}

const FOR_THE_HOST = '-h -I srv-host -n 10.0.0.2';

describe('certificat d\'hote', () => {
  it('TEMOIN: sans certificat ni cle connue, StrictHostKeyChecking=yes refuse', async () => {
    const lab = await buildLab(null);
    await trustCa(lab, '10.0.0.2');

    expect(await lab.pc.executeCommand(`${SSH('yes')} whoami`)).toContain('No ED25519 host key is known for 10.0.0.2 and you have requested strict checking.');
  }, 120_000);

  it('un certificat signe par l\'AC connue est accepte sans toucher known_hosts', async () => {
    const lab = await buildLab(FOR_THE_HOST);
    await trustCa(lab, '10.0.0.2');
    const before = await lab.pc.executeCommand('cat ~/.ssh/known_hosts');

    const out = await lab.pc.executeCommand(`${SSH('yes')} whoami`);
    expect(out.trim()).toBe('alice');
    expect(await lab.pc.executeCommand('cat ~/.ssh/known_hosts')).toBe(before);
  }, 120_000);

  it('un motif de nom joker dans @cert-authority convient', async () => {
    const lab = await buildLab(FOR_THE_HOST);
    await trustCa(lab, '10.0.*');

    expect((await lab.pc.executeCommand(`${SSH('yes')} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('une ligne @cert-authority pour un autre hote ne convient pas', async () => {
    const lab = await buildLab(FOR_THE_HOST);
    await trustCa(lab, '192.168.*');

    expect(await lab.pc.executeCommand(`${SSH('yes')} whoami`)).toContain('No ED25519 host key is known for 10.0.0.2');
  }, 120_000);

  it('un autre nom dans le certificat est refuse', async () => {
    const lab = await buildLab('-h -I srv-host -n other.lab');
    await trustCa(lab, '10.0.0.2');

    const out = await lab.pc.executeCommand(`${SSH('yes')} whoami`);
    expect(out).toContain('Certificate invalid: name is not a listed principal');
    expect(out).toContain('No ED25519 host key is known for 10.0.0.2');
  }, 120_000);

  it('un certificat expire est refuse', async () => {
    const lab = await buildLab(`${FOR_THE_HOST} -V 20200101:20210101`);
    await trustCa(lab, '10.0.0.2');

    expect(await lab.pc.executeCommand(`${SSH('yes')} whoami`)).toContain('Certificate invalid: expired');
  }, 120_000);

  it('un certificat utilisateur n\'est pas un certificat d\'hote', async () => {
    const lab = await buildLab('-I srv-host -n 10.0.0.2');
    await trustCa(lab, '10.0.0.2');

    expect(await lab.pc.executeCommand(`${SSH('yes')} whoami`)).toContain('No ED25519 host key is known for 10.0.0.2');
  }, 120_000);

  it('une option critique inconnue est refusee', async () => {
    const lab = await buildLab(`${FOR_THE_HOST} -O critical:surprise=1`);
    await trustCa(lab, '10.0.0.2');

    expect(await lab.pc.executeCommand(`${SSH('yes')} whoami`)).toContain('Certificate for 10.0.0.2 contains unsupported critical options(s)');
  }, 120_000);

  it('sans AC connue, le client retombe sur la cle nue (accept-new)', async () => {
    const lab = await buildLab(FOR_THE_HOST);

    const out = await lab.pc.executeCommand(`${SSH('accept-new')} whoami`);
    expect(out).toContain('alice');
    expect(await lab.pc.executeCommand('cat ~/.ssh/known_hosts')).toMatch(/^\|1\|\S+ ssh-ed25519 AAAA/);
  }, 120_000);

  it('le certificat est celui qui se presente sur le fil', async () => {
    const lab = await buildLab(FOR_THE_HOST);
    await trustCa(lab, '10.0.0.2');
    const out = await lab.pc.executeCommand(`ssh -v -o BatchMode=yes -o StrictHostKeyChecking=yes -i ~/id alice@10.0.0.2 whoami`);

    expect(out).toContain('debug1: kex: host key algorithm: ssh-ed25519-cert-v01@openssh.com');
    expect(out).toMatch(/Server host certificate: ssh-ed25519-cert-v01@openssh\.com SHA256:[A-Za-z0-9+/]{43}, serial 0 ID "srv-host" CA ssh-ed25519 SHA256:[A-Za-z0-9+/]{43} valid forever/);
  }, 120_000);
});
