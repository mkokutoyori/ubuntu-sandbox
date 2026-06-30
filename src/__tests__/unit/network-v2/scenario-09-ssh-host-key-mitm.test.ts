import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab { client: LinuxPC; server: LinuxServer; sw: GenericSwitch; }

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SERVER', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);

  const um = (server as unknown as { executor: { userMgr: {
    useradd: (u: string, o?: object) => void;
    setPassword: (u: string, p: string) => void;
    getUser: (u: string) => unknown;
  } } }).executor.userMgr;
  if (!um.getUser('alice')) {
    um.useradd('alice', { m: true, s: '/bin/bash' });
    um.setPassword('alice', 'wonderland');
  }
  return { client, server, sw };
}

function readPubKey(server: LinuxServer): string {
  const raw = (server as unknown as { executor: { vfs: { readFile: (p: string) => string | null } } })
    .executor.vfs.readFile('/etc/ssh/ssh_host_ed25519_key.pub') ?? '';
  return raw.trim().split(/\s+/)[1] ?? '';
}

describe('Scenario 9 — Détection d\'usurpation de clé d\'hôte (MITM)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('première connexion enregistre la clé du serveur dans known_hosts', async () => {
    const { client, server } = await buildLab();
    server.getSshServerContext();
    const out = await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo ok"',
      'wonderland\n',
    );
    expect(out).not.toMatch(/Host key verification failed/i);
    const kh = await client.executeCommand('cat /root/.ssh/known_hosts');
    expect(kh).toContain('10.0.0.2');
    expect(kh).toContain('ssh-ed25519');
    expect(kh).toContain(readPubKey(server));
  });

  it('régénération de la clé serveur change le fingerprint exposé', async () => {
    const { server } = await buildLab();
    server.getSshServerContext();
    const before = readPubKey(server);
    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');
    const after = readPubKey(server);
    expect(after).not.toBe('');
    expect(after).not.toBe(before);
  });

  it('reconnexion après rotation déclenche WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', async () => {
    const { client, server } = await buildLab();
    server.getSshServerContext();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo first"',
      'wonderland\n',
    );
    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');
    await server.executeCommand('systemctl restart ssh');
    const out = await client.executeCommand(
      'ssh alice@10.0.0.2 "echo second"',
      'wonderland\n',
    );
    expect(out).toMatch(/WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!/);
    expect(out).toMatch(/Host key verification failed|Offending key/i);
    expect(out).not.toContain('second');
  });

  it('known_hosts conserve l\'ancienne entrée tant que l\'utilisateur ne la supprime pas', async () => {
    const { client, server } = await buildLab();
    server.getSshServerContext();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo first"',
      'wonderland\n',
    );
    const before = await client.executeCommand('cat /root/.ssh/known_hosts');
    const oldPub = readPubKey(server);
    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');
    await server.executeCommand('systemctl restart ssh');
    await client.executeCommand('ssh alice@10.0.0.2 "echo second"', 'wonderland\n');
    const after = await client.executeCommand('cat /root/.ssh/known_hosts');
    expect(after).toBe(before);
    expect(after).toContain(oldPub);
  });

  it('après ssh-keygen -R <ip>, la reconnexion réussit et enregistre la nouvelle clé', async () => {
    const { client, server } = await buildLab();
    server.getSshServerContext();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo first"',
      'wonderland\n',
    );
    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');
    await server.executeCommand('systemctl restart ssh');
    const blocked = await client.executeCommand('ssh alice@10.0.0.2 "echo blocked"', 'wonderland\n');
    expect(blocked).toMatch(/REMOTE HOST IDENTIFICATION HAS CHANGED/);

    const removed = await client.executeCommand('ssh-keygen -R 10.0.0.2');
    expect(removed).toMatch(/known_hosts updated|Host 10\.0\.0\.2 found/i);
    const newPub = readPubKey(server);
    const retry = await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo recovered"',
      'wonderland\n',
    );
    expect(retry).not.toMatch(/REMOTE HOST IDENTIFICATION HAS CHANGED/);
    const kh = await client.executeCommand('cat /root/.ssh/known_hosts');
    expect(kh).toContain(newPub);
  });
});
