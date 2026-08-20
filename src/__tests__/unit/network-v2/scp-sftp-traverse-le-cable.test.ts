/**
 * Phase 4 de la refonte SSH — le critère d'acceptation de l'audit :
 * un `scp`/`sftp` doit faire passer des octets sur le vrai câble, pas
 * copier d'un VFS à l'autre en mémoire.
 *
 * La mesure est un compteur de trames sur le câble intermédiaire, pris
 * avant et après le transfert. C'est la seule chose qui distingue « le
 * fichier est arrivé » de « le fichier a VOYAGÉ » : la copie directe
 * faisait arriver le fichier tout aussi bien, sans qu'aucune trame ne
 * soit émise.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';

const CLI = '10.90.0.10';
const SRV = '10.90.0.20';
const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function lab() {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const c1 = new Cable('c1');
  const c2 = new Cable('c2');
  c1.connect(client.getPorts()[0], sw.getPorts()[0]);
  c2.connect(server.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress(CLI), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SRV), MASK);
  client.powerOn();
  server.powerOn();
  return { client, server, c1 };
}

/** Trames vues par le câble du client — la mesure de « ça a voyagé ». */
function frames(c: Cable): number {
  const s = c.getStats() as { framesTransmitted?: number; frames?: number };
  return s.framesTransmitted ?? s.frames ?? 0;
}

/**
 * Pose une clé publique du client dans l'`authorized_keys` du serveur :
 * c'est ce qui rend un `scp` SANS mot de passe authentifiable pour de
 * vrai, exactement comme sur une vraie machine.
 */
async function autoriserLaCle(client: LinuxPC, server: LinuxServer, user: string): Promise<void> {
  await client.executeCommand('ssh-keygen -t rsa -N "" -f /root/.ssh/id_rsa');
  const pub = (await client.executeCommand('cat /root/.ssh/id_rsa.pub')).trim();
  await server.executeCommand(`mkdir -p /home/${user}/.ssh`);
  await server.executeCommand(`sh -c 'echo "${pub}" > /home/${user}/.ssh/authorized_keys'`);
  await server.executeCommand(`chmod 700 /home/${user}/.ssh`);
  await server.executeCommand(`chmod 600 /home/${user}/.ssh/authorized_keys`);
  await server.executeCommand(`chown -R ${user}:${user} /home/${user}/.ssh`);
}

describe('Phase 4 — scp/sftp passent par le câble', () => {
  it('un scp authentifié par clé émet des trames sur le câble', async () => {
    const { client, server, c1 } = await lab();
    await server.executeCommand('useradd -m -s /bin/bash alice');
    await autoriserLaCle(client, server, 'alice');
    await client.executeCommand(`sh -c 'echo "contenu transporte" > /tmp/charge.txt'`);

    const avant = frames(c1);
    const out = await client.executeCommand(`scp /tmp/charge.txt alice@${SRV}:/home/alice/recu.txt`);
    const apres = frames(c1);

    expect(out).not.toContain('no route to host');
    // Le fichier est arrivé…
    expect(await server.executeCommand('cat /home/alice/recu.txt')).toContain('contenu transporte');
    // …et il a voyagé.
    expect(apres).toBeGreaterThan(avant);
  }, 60_000);

  it('un sftp par lot dépose lui aussi son fichier à travers le câble', async () => {
    const { client, server, c1 } = await lab();
    await server.executeCommand('useradd -m -s /bin/bash alice');
    await autoriserLaCle(client, server, 'alice');
    await client.executeCommand(`sh -c 'echo "par lot" > /tmp/lot.txt'`);
    await client.executeCommand(
      `sh -c 'printf "put /tmp/lot.txt /home/alice/lot.txt\\nbye\\n" > /tmp/batch.sftp'`);

    const avant = frames(c1);
    await client.executeCommand(`sftp -b /tmp/batch.sftp alice@${SRV}`);
    const apres = frames(c1);

    expect(await server.executeCommand('cat /home/alice/lot.txt')).toContain('par lot');
    expect(apres).toBeGreaterThan(avant);
  }, 60_000);

  /**
   * Le compte porte un mot de passe et le client n'en offre aucun : la
   * session filaire ne s'ouvre pas, et le transfert est REFUSÉ plutôt
   * que servi par la résolution directe. C'était le dernier endroit où
   * un fichier pouvait arriver sans avoir voyagé — le repli mémoire ne
   * répare plus une authentification qui a échoué.
   */
  it('sans clé ni mot de passe, le transfert est REFUSÉ', async () => {
    const { client, server, c1 } = await lab();
    await server.executeCommand('useradd -m -s /bin/bash bob');
    await server.executeCommand('sh -c \'echo "bob:secret" | chpasswd\'');
    await client.executeCommand(`sh -c 'echo "sans clef" > /tmp/nokey.txt'`);

    const avant = frames(c1);
    const out = await client.executeCommand(`scp /tmp/nokey.txt bob@${SRV}:/home/bob/nokey.txt`);
    const apres = frames(c1);

    expect(out).toMatch(/Permission denied/);
    expect(await server.executeCommand('cat /home/bob/nokey.txt')).toMatch(/No such file/);
    // Le refus se prononce sur le fil : la tentative d'authentification
    // a bien eu lieu, elle a seulement échoué.
    expect(apres).toBeGreaterThan(avant);
  }, 60_000);

  /**
   * Le même compte, le même transfert, avec le mot de passe : il passe.
   * Sans ce témoin, le cas ci-dessus ne distinguerait pas « refusé
   * parce que non authentifié » de « labo mal construit ».
   */
  it('avec le mot de passe, le même transfert aboutit par le câble', async () => {
    const { client, server, c1 } = await lab();
    await server.executeCommand('useradd -m -s /bin/bash bob');
    await server.executeCommand('sh -c \'echo "bob:secret" | chpasswd\'');
    await client.executeCommand(`sh -c 'echo "avec clef" > /tmp/withpw.txt'`);

    const avant = frames(c1);
    await client.executeCommand(`sshpass -p secret scp /tmp/withpw.txt bob@${SRV}:/home/bob/withpw.txt`);
    const apres = frames(c1);

    expect(await server.executeCommand('cat /home/bob/withpw.txt')).toContain('avec clef');
    expect(apres).toBeGreaterThan(avant);
  }, 60_000);
});
