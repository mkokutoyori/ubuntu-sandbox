import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
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

function buildLab() {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  const um = (server as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'wonderland');
  server.getSshServerContext();
  return { client, server };
}

describe('Scénario 4 — sshd_config: dérive fichier vs configuration en mémoire', () => {
  it('sshd -T reflète encore l\'ancienne valeur tant que "systemctl reload ssh" n\'a pas tourné', async () => {
    const { server } = buildLab();
    const before = await server.executeCommand('sshd -T');
    expect(before).toMatch(/passwordauthentication yes/);

    await server.executeCommand("sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config");
    const stillOld = await server.executeCommand('sshd -T');
    expect(stillOld).toMatch(/passwordauthentication yes/);

    await server.executeCommand('systemctl reload ssh');
    const afterReload = await server.executeCommand('sshd -T');
    expect(afterReload).toMatch(/passwordauthentication no/);
  });

  it('"systemctl reload ssh" journalise Received SIGHUP; restarting sans couper les sessions', async () => {
    const { server } = buildLab();
    await server.executeCommand('systemctl reload ssh');
    const journal = await server.executeCommand('journalctl -u ssh');
    expect(journal).toMatch(/Received SIGHUP; restarting/);
  });

  it('"sshd -t" valide la syntaxe du fichier avant tout rechargement', async () => {
    const { server } = buildLab();
    const ok = await server.executeCommand('sshd -t');
    expect(ok.trim()).toBe('');

    await server.executeCommand("printf 'Port 999999\\n' >> /etc/ssh/sshd_config");
    const bad = await server.executeCommand('sshd -t');
    expect(bad.trim()).not.toBe('');
  });
});

describe('Scénario 4 — authorized_keys: permissions incorrectes ignorées silencieusement', () => {
  it('authorized_keys en 644 fait échouer l\'authentification par clé et journalise la cause', async () => {
    const { client, server } = buildLab();
    await client.executeCommand("ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519");
    await client.executeCommand('ssh-copy-id -i /root/.ssh/id_ed25519.pub alice@10.0.0.2', 'wonderland\n');
    await server.executeCommand('chmod 644 /home/alice/.ssh/authorized_keys');

    await client.executeCommand('ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 "echo ok"');

    const authLog = await server.executeCommand('cat /var/log/auth.log');
    expect(authLog).toMatch(/Authentication refused: bad ownership or modes for file \/home\/alice\/\.ssh\/authorized_keys/);
  });

  it('un répertoire ~/.ssh appartenant à un autre utilisateur est également refusé', async () => {
    const { client, server } = buildLab();
    const um = (server as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void } } }).executor.userMgr;
    um.useradd('bob', { m: true, s: '/bin/bash' });
    await client.executeCommand("ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519");
    await client.executeCommand('ssh-copy-id -i /root/.ssh/id_ed25519.pub alice@10.0.0.2', 'wonderland\n');
    await server.executeCommand('chown -R bob:bob /home/alice/.ssh');

    await client.executeCommand('ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 "echo ok"');
    const authLog = await server.executeCommand('cat /var/log/auth.log');
    expect(authLog).toMatch(/Authentication refused: bad ownership or modes for file \/home\/alice\/\.ssh/);
  });
});

describe('Scénario 4 — known_hosts: détection et résolution d\'une entrée corrompue', () => {
  it('une empreinte incorrecte refuse la connexion par défaut', async () => {
    const { client, server } = buildLab();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo first"',
      'wonderland\n',
    );
    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');
    await server.executeCommand('systemctl restart ssh');

    const out = await client.executeCommand('ssh alice@10.0.0.2 "echo second"', 'wonderland\n');
    expect(out).toMatch(/WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!/);
  });

  it('ssh-keygen -R puis ssh-keyscan permettent de valider et ré-enregistrer la nouvelle empreinte', async () => {
    const { client, server } = buildLab();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo first"',
      'wonderland\n',
    );
    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');
    await server.executeCommand('systemctl restart ssh');

    await client.executeCommand('ssh-keygen -R 10.0.0.2');
    const scanned = await client.executeCommand('ssh-keyscan 10.0.0.2');
    expect(scanned).toMatch(/^10\.0\.0\.2 ssh-(ed25519|rsa) /m);

    await client.executeCommand(`sh -c 'ssh-keyscan 10.0.0.2 >> /root/.ssh/known_hosts'`);
    const out = await client.executeCommand('ssh alice@10.0.0.2 "echo second"', 'wonderland\n');
    expect(out).not.toMatch(/WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!/);
    expect(out).toContain('second');
  });

  it('StrictHostKeyChecking=no accepte la connexion malgré l\'empreinte incorrecte (risque documenté)', async () => {
    const { client, server } = buildLab();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 "echo first"',
      'wonderland\n',
    );
    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');
    await server.executeCommand('systemctl restart ssh');

    const out = await client.executeCommand(
      'ssh -o StrictHostKeyChecking=no alice@10.0.0.2 "echo second"',
      'wonderland\n',
    );
    expect(out).not.toMatch(/WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!/);
    expect(out).toContain('second');
  });
});
