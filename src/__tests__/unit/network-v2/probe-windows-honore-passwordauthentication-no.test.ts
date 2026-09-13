/**
 * `-o PasswordAuthentication=no` retire le repli par mot de passe — des
 * deux cotes du parc, pas seulement sous Linux.
 *
 * Ecrite a l'aveugle depuis OpenSSH et depuis le comportement DEJA JUSTE
 * du client Linux de ce depot, qui sert ici de reference :
 *
 *   - avec l'option, seule une cle qui figure dans l'`authorized_keys` du
 *     serveur ouvre la session ; sinon `Permission denied (publickey).`
 *     (ssh.c / auth2.c : la liste des methodes se reduit a `publickey`) ;
 *   - sans l'option, ce simulateur garde sa convention assumee — un `ssh`
 *     qui n'offre aucune justificatif vaut « l'operateur a tape son mot de
 *     passe a l'invite » (LinuxSshClient, verifyOfferedPassword : « keep the
 *     simulator's existing trust default intact for callers that don't
 *     drive sshpass »). Cette convention n'est PAS remise en cause ici :
 *     elle est identique sur les deux plateformes, et la changer toucherait
 *     268 appels de test. Ce qui est corrige, c'est que Windows l'appliquait
 *     MEME quand le client avait explicitement retire le repli.
 *
 * Le serveur Windows sait deja authentifier — `WindowsSshServerContext`
 * expose un `ISshAuthContext` avec `checkPublicKey`. C'est le CLIENT Windows
 * qui ne le lui demandait jamais : il accordait la session sur la seule
 * politique de compte. Le correctif ne reecrit aucun verificateur, il
 * branche le client sur celui qui existe.
 *
 * Mesure avant correction : 4 cas tombent sur 7.
 * Les 3 qui passent des deux cotes sont nommes :
 *   - « une cle qui correspond ouvre la session » : TEMOIN, sans lui une
 *     sonde faite de refus ne prouverait rien ;
 *   - « sans l'option, la convention du simulateur tient » : NON-REGRESSION,
 *     c'est le comportement volontairement conserve ;
 *   - « le client Linux refuse deja » : REFERENCE, c'est la reponse que
 *     Windows doit rejoindre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const SANS_REPLI = '-o StrictHostKeyChecking=no -o PasswordAuthentication=no';

async function labo(): Promise<{ win: WindowsPC; pc: LinuxPC; srv: LinuxServer }> {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  [win, pc, srv].forEach((d, i) => {
    d.powerOn();
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  const m = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), m);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\etrangere');
  return { win, pc, srv };
}

async function autoriseLaCleDe(srv: LinuxServer, publique: string): Promise<void> {
  await srv.executeCommand('sudo mkdir -p /home/alice/.ssh');
  await srv.executeCommand(`echo "${publique}" | sudo tee /home/alice/.ssh/authorized_keys`);
  await srv.executeCommand('sudo chown -R alice:alice /home/alice/.ssh');
  await srv.executeCommand('sudo chmod 600 /home/alice/.ssh/authorized_keys');
}

describe('Windows honore le retrait du repli par mot de passe', () => {
  it('une cle ETRANGERE ne suffit pas', async () => {
    const { win } = await labo();
    const out = await win.executeCommand(
      `ssh ${SANS_REPLI} -i C:\\etrangere alice@10.0.0.2 hostname`);
    expect(out).toContain('alice@10.0.0.2: Permission denied (publickey).');
  });

  it('AUCUNE cle ne suffit pas non plus', async () => {
    const { win } = await labo();
    const out = await win.executeCommand(`ssh ${SANS_REPLI} alice@10.0.0.2 hostname`);
    expect(out).toContain('alice@10.0.0.2: Permission denied (publickey).');
  });

  it('une cle qui correspond ouvre la session', async () => {
    const { win, srv } = await labo();
    await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\bonne');
    await autoriseLaCleDe(srv, (await win.executeCommand('type C:\\bonne.pub')).trim());
    const out = await win.executeCommand(
      `ssh ${SANS_REPLI} -i C:\\bonne alice@10.0.0.2 hostname`);
    expect(out.trim()).toBe('linux-server');
  });

  it('sans l option, la convention du simulateur tient', async () => {
    const { win } = await labo();
    const out = await win.executeCommand(
      'ssh -o StrictHostKeyChecking=no alice@10.0.0.2 hostname');
    expect(out.trim()).toBe('linux-server');
  });

  it('un SERVEUR qui refuse le mot de passe est honore sans option cliente', async () => {
    const { win, srv } = await labo();
    await srv.executeCommand(
      'echo "PasswordAuthentication no" | sudo tee -a /etc/ssh/sshd_config');
    await srv.executeCommand('sudo systemctl restart ssh');
    const out = await win.executeCommand(
      'ssh -o StrictHostKeyChecking=no alice@10.0.0.2 hostname');
    expect(out).toContain('alice@10.0.0.2: Permission denied (publickey).');
  });

  it('`sftp` repond comme `ssh` : une machine, une politique', async () => {
    const { win, srv } = await labo();
    const refus = await win.executeCommand(
      `sftp ${SANS_REPLI} -i C:\\etrangere alice@10.0.0.2`);
    expect(refus).toContain('Permission denied (publickey).');
    await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\bonne');
    await autoriseLaCleDe(srv, (await win.executeCommand('type C:\\bonne.pub')).trim());
    const accepte = await win.executeCommand(
      `sftp ${SANS_REPLI} -i C:\\bonne alice@10.0.0.2`);
    expect(accepte).not.toContain('Permission denied');
  });

  it('le client Linux refuse deja, et c est la reponse a rejoindre', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(`ssh ${SANS_REPLI} alice@10.0.0.2 hostname`);
    expect(out).toContain('alice@10.0.0.2: Permission denied (publickey).');
  });
});
