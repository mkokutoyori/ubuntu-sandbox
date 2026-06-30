/**
 * Scénario 2 — Bascule clé → mot de passe en cas de permissions
 * incorrectes.
 *
 * Reproduit le cas réel où SSH ignore une clé valide à cause de
 * permissions trop ouvertes, et confirme que le simulateur modélise ce
 * comportement.
 *
 * Déroulé : sur le serveur, on modifie les permissions de
 * authorized_keys à 666 (ou de $HOME à 777), puis on tente une
 * connexion par clé.
 *
 * Points de contrôle :
 *   - log serveur indiquant le refus silencieux de la clé
 *     (« Authentication refused: bad ownership or modes for file … ») ;
 *   - le client bascule vers le mot de passe (publickey refusée,
 *     fallback password réussit).
 *
 * Critère de réussite : le simulateur refuse la clé et propose le
 * mot de passe, exactement comme un vrai daemon SSH.
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

async function buildLan() {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');
  return { pc, srv };
}

function srvVfs(srv: LinuxServer) {
  return (srv as unknown as { executor: { vfs: {
    readFile(p: string): string | null;
  } } }).executor.vfs;
}

async function deployKey(pc: LinuxPC) {
  await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
  await pc.executeCommand('ssh-copy-id alice@10.0.0.2');
}

describe('Scénario 2 — bascule clé → mot de passe sur perms incorrectes', () => {
  it('chmod 666 sur authorized_keys : le log écrit "Authentication refused: bad ownership or modes"', async () => {
    const { pc, srv } = await buildLan();
    await deployKey(pc);

    await srv.executeCommand('chmod 0666 /home/alice/.ssh/authorized_keys');
    await pc.executeCommand('ssh alice@10.0.0.2 whoami');

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Authentication refused: bad ownership or modes for file \/home\/alice\/\.ssh\/authorized_keys/);
  });

  it('chmod 666 sur authorized_keys : la connexion bascule sur le mot de passe et réussit', async () => {
    const { pc, srv } = await buildLan();
    await deployKey(pc);
    await srv.executeCommand('chmod 0666 /home/alice/.ssh/authorized_keys');

    // PreferredAuthentications par défaut = publickey,password. Le
    // simulateur doit refuser la clé (perms cassées) puis accepter via
    // password (alice a un mot de passe valide).
    const out = await pc.executeCommand('ssh alice@10.0.0.2 whoami');
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Permission denied/i);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for alice/);
    expect(log).not.toMatch(/Accepted publickey for alice/);
  });

  it('chmod 666 sur authorized_keys + PasswordAuthentication=no : refus complet', async () => {
    const { pc, srv } = await buildLan();
    await deployKey(pc);
    await srv.executeCommand('chmod 0666 /home/alice/.ssh/authorized_keys');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(out).toMatch(/Permission denied/i);
    expect(out).not.toMatch(/^alice\s*$/m);
  });

  it('chmod 777 sur $HOME alice : la clé est silencieusement refusée et password prend le relais', async () => {
    const { pc, srv } = await buildLan();
    await deployKey(pc);

    await srv.executeCommand('chmod 0777 /home/alice');
    const out = await pc.executeCommand('ssh alice@10.0.0.2 whoami');

    expect(out).toMatch(/^alice\s*$/m);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Authentication refused: bad ownership or modes for file \/home\/alice/);
    expect(log).toMatch(/Accepted password for alice/);
    expect(log).not.toMatch(/Accepted publickey for alice/);
  });

  it('sanity : sans relâchement, la clé reste acceptée (Accepted publickey, pas de password)', async () => {
    const { pc, srv } = await buildLan();
    await deployKey(pc);

    const out = await pc.executeCommand('ssh alice@10.0.0.2 whoami');
    expect(out).toMatch(/^alice\s*$/m);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted publickey for alice/);
    expect(log).not.toMatch(/Authentication refused: bad ownership or modes/);
    expect(log).not.toMatch(/Accepted password for alice/);
  });
});
