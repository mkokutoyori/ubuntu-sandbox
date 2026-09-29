/*
 * L'authentification par cle prouve la possession de la cle PRIVEE.
 *
 * L'AUTORITE :
 * - RFC 4252 §7 : le client peut d'abord demander si une cle serait
 *   acceptable (requete sans signature, reponse SSH_MSG_USERAUTH_PK_OK) ;
 *   la requete qui authentifie porte une signature, faite avec la cle
 *   privee, sur l'identifiant de session suivi des champs de la requete.
 *   Le serveur verifie cette signature avec la cle publique annoncee, et
 *   n'accepte que si la cle est autorisee ET la signature valide ;
 * - RFC 8709 §6 (ssh-ed25519), RFC 8332 (rsa-sha2-256), RFC 5656 §3.1.2
 *   (ecdsa-sha2-nistp256) : les formats de signature ;
 * - OpenSSH 8.9p1, `auth.c` (`auth_log`, `format_method_key`) : une
 *   connexion par cle s'ecrit « Accepted publickey for <u> from <ip> port
 *   <p> ssh2: <TYPE> SHA256:<empreinte> ».
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire le serveur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
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

const SERVER = '10.0.0.2';

interface Lab { client: LinuxPC; server: LinuxServer }

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  const client = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('a').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress(SERVER), mask);
  await server.executeCommand('sudo useradd -m -s /bin/bash alice');
  await server.executeCommand('echo "alice:s3cret" | sudo chpasswd');
  await server.executeCommand('sudo systemctl restart ssh');
  await client.executeCommand(`ping -c 1 ${SERVER}`);
  return { client, server };
}

async function authorize(lab: Lab, publicLine: string): Promise<void> {
  await lab.server.executeCommand('sudo mkdir -p /home/alice/.ssh');
  await lab.server.executeCommand(`echo '${publicLine}' | sudo tee /home/alice/.ssh/authorized_keys`);
  await lab.server.executeCommand('sudo chown -R alice:alice /home/alice/.ssh');
  await lab.server.executeCommand('sudo chmod 700 /home/alice/.ssh');
  await lab.server.executeCommand('sudo chmod 600 /home/alice/.ssh/authorized_keys');
}

async function keyOf(lab: Lab, type: string, file: string): Promise<string> {
  await lab.client.executeCommand(`ssh-keygen -t ${type} -N '' -f ~/.ssh/${file} -q`);
  return (await lab.client.executeCommand(`cat ~/.ssh/${file}.pub`)).trim();
}

const login = (lab: Lab) => lab.client.executeCommand(`ssh -o BatchMode=yes alice@${SERVER} whoami`);

describe('an authorized key whose private half the client holds opens the session', () => {
  it('Ed25519 — WITNESS', async () => {
    const lab = await buildLab();
    await authorize(lab, await keyOf(lab, 'ed25519', 'id_ed25519'));

    expect(await login(lab)).toMatch(/^alice$/m);
  });

  it('RSA, signed with rsa-sha2-256 — WITNESS', async () => {
    const lab = await buildLab();
    await authorize(lab, await keyOf(lab, 'rsa -b 2048', 'id_rsa'));

    expect(await login(lab)).toMatch(/^alice$/m);
  }, 60_000);

  it('ECDSA P-256', async () => {
    const lab = await buildLab();
    await authorize(lab, await keyOf(lab, 'ecdsa', 'id_ecdsa'));

    expect(await login(lab)).toMatch(/^alice$/m);
  });
});

describe('the public half alone proves nothing', () => {
  it('the authorized .pub beside ANOTHER private key is refused', async () => {
    const lab = await buildLab();
    const authorized = await keyOf(lab, 'ed25519', 'id_ed25519');
    await authorize(lab, authorized);
    await lab.client.executeCommand("ssh-keygen -t ed25519 -N '' -f /tmp/other -q");
    await lab.client.executeCommand('cp /tmp/other ~/.ssh/id_ed25519');

    const out = await login(lab);
    expect(out).not.toMatch(/^alice$/m);
    expect(out).toContain(`alice@${SERVER}: Permission denied (publickey,password).`);
  });

  it('the authorized .pub beside an unreadable private key is refused', async () => {
    const lab = await buildLab();
    await authorize(lab, await keyOf(lab, 'ed25519', 'id_ed25519'));
    await lab.client.executeCommand("printf 'not a key\\n' > ~/.ssh/id_ed25519");

    expect(await login(lab)).not.toMatch(/^alice$/m);
  });
});

describe('sshd names the key that authenticated', () => {
  it('auth.log gives its type and fingerprint', async () => {
    const lab = await buildLab();
    await authorize(lab, await keyOf(lab, 'rsa -b 2048', 'id_rsa'));
    const fingerprint = (await lab.client.executeCommand('ssh-keygen -l -f ~/.ssh/id_rsa.pub')).split(' ')[1];

    expect(await login(lab)).toMatch(/^alice$/m);
    expect(await lab.server.executeCommand('sudo cat /var/log/auth.log'))
      .toMatch(new RegExp(`Accepted publickey for alice from 10\\.0\\.0\\.1 port \\d+ ssh2: RSA ${fingerprint.replace(/[+/]/g, '\\$&')}`));
  }, 60_000);
});
