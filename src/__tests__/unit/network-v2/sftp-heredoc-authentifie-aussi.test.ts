/**
 * Le document en ligne est le trou que la Phase 4 a laissé ouvert.
 *
 * `scp`/`sftp` tapés seuls passent par `runSshTransportAsync` et donc par
 * une vraie session ; écrits avec un document en ligne
 * (`sftp user@hote <<'EOF'`) ils partent sur le chemin synchrone, qui
 * n'essaie jamais le câble et saisit le VFS distant en mémoire.
 *
 * La mesure qui tranche n'est pas « le fichier est arrivé » — la copie
 * directe le fait arriver aussi — mais le refus : sans justificatif, la
 * forme SANS document en ligne est refusée. Si la forme AVEC réussit sur
 * le même labo et le même compte, c'est qu'elle a court-circuité
 * l'authentification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';

const CLI = '10.91.0.10';
const SRV = '10.91.0.20';
const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function lab() {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress(CLI), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SRV), MASK);
  client.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash zoe');
  await server.executeCommand(`sh -c 'echo "zoe:secret" | chpasswd'`);
  return { client, server };
}

describe('le document en ligne ne contourne pas l\'authentification', () => {
  it('la référence : sans document en ligne, sans mot de passe, sftp est refusé', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(`sftp zoe@${SRV}`);
    expect(out).toMatch(/Permission denied/);
  }, 60_000);

  it('avec un document en ligne, le même sftp est refusé de la même façon', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(
      `sftp zoe@${SRV} <<'EOF'\npwd\nbye\nEOF`);
    expect(out).toMatch(/Permission denied/);
  }, 60_000);

  it('avec le mot de passe, le document en ligne aboutit', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(
      `sshpass -p secret sftp zoe@${SRV} <<'EOF'\npwd\nbye\nEOF`);
    expect(out).toMatch(/Connected to/);
    expect(out).not.toMatch(/Permission denied/);
  }, 60_000);

  it('un scp dans une ligne composée est refusé lui aussi', async () => {
    const { client } = await lab();
    await client.executeCommand(`sh -c 'echo charge > /tmp/c.txt'`);
    const out = await client.executeCommand(
      `scp /tmp/c.txt zoe@${SRV}:/home/zoe/c.txt; echo rc=$?`);
    expect(out).toMatch(/Permission denied/);
    expect(out).toMatch(/rc=1/);
  }, 60_000);
});
