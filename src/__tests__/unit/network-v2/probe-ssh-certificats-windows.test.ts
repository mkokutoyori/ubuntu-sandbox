/*
 * Les certificats SSH sur Windows : le client Win32-OpenSSH 8.6p1 presente
 * <identite>-cert.pub, le service sshd de Windows reconnait TrustedUserCAKeys,
 * RevokedKeys (cles et KRL) et HostCertificate comme celui de Linux.
 *
 * L'AUTORITE : les memes sources OpenSSH 8.9p1/8.6p1 que les sondes Linux
 * (auth2-pubkey.c, auth-options.c, sshconnect.c, krl.c, PROTOCOL.certkeys) ;
 * Win32-OpenSSH les construit telles quelles, avec ses fichiers sous
 * C:\ProgramData\ssh et C:\Users\<u>\.ssh.
 *
 * Ecrite contre ces sources. 1 des 7 cas tombe avant le branchement du
 * service de certificats sur la machine Windows : HostCertificate du serveur
 * Windows (le client ne voyait que la cle nue). Passent des deux cotes, par
 * non-regression : l'admission de certificat utilisateur du serveur Windows
 * (TrustedUserCAKeys, RevokedKeys) et le client Windows, deja couverts par
 * le contexte Windows ; les refus (principal, AC absente) en sont les temoins.
 * Les directives vont AVANT le bloc « Match Group administrators » du
 * sshd_config Windows, comme sshd l'exige.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function wire(devices: Array<{ getPorts(): Array<{ configureIP(ip: IPAddress, mask: SubnetMask): void }> }>, prefix: string): void {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  devices.forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0] as never, sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(`${prefix}.${10 + index * 10}`), mask);
  });
}

describe('client Windows vers serveur Linux', () => {
  async function lab() {
    const win = new WindowsPC('windows-pc', 'WIN');
    const server = new LinuxServer('linux-server', 'SRV');
    wire([win, server], '10.93.0');
    win.powerOn();
    server.powerOn();
    await server.executeCommand('useradd -m -s /bin/bash bob');
    await win.executeCommand('ssh-keygen -q -t ed25519 -N "" -C bob@win -f C:\\id');
    await win.executeCommand('ssh-keygen -q -t ed25519 -N "" -C ca@win -f C:\\ca');
    const authority = (await win.executeCommand('type C:\\ca.pub')).trim().split(' ').slice(0, 2).join(' ');
    await server.executeCommand(`sh -c 'echo "${authority}" > /etc/ssh/ca.pub'`);
    await server.executeCommand(`sh -c 'echo "TrustedUserCAKeys /etc/ssh/ca.pub" >> /etc/ssh/sshd_config'`);
    await server.executeCommand('systemctl restart ssh');
    return { win, server };
  }

  const SSH = 'ssh -o StrictHostKeyChecking=no -o PasswordAuthentication=no -i C:\\id bob@10.93.0.20';

  it('TEMOIN: sans certificat, la cle seule est refusee (aucun authorized_keys)', async () => {
    const { win } = await lab();
    expect(await win.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
  }, 120_000);

  it('id-cert.pub signe par l\'AC de confiance ouvre la session', async () => {
    const { win, server } = await lab();
    await win.executeCommand('ssh-keygen -q -s C:\\ca -I bob-key -n bob -z 3 C:\\id.pub');
    expect((await win.executeCommand(`${SSH} whoami`)).trim()).toBe('bob');
    expect(await server.executeCommand('cat /var/log/auth.log'))
      .toMatch(/Accepted publickey for bob from 10\.93\.0\.10 port \d+ ssh2: ED25519-CERT SHA256:\S+ ID bob-key \(serial 3\) CA ED25519 SHA256:/);
  }, 120_000);

  it('un autre principal est refuse', async () => {
    const { win, server } = await lab();
    await win.executeCommand('ssh-keygen -q -s C:\\ca -I bob-key -n alice C:\\id.pub');
    expect(await win.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await server.executeCommand('cat /var/log/auth.log')).toContain('error: Certificate invalid: name is not a listed principal');
  }, 120_000);
});

describe('serveur Windows', () => {
  async function lab() {
    const client = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const server = new WindowsPC('windows-pc', 'WSRV');
    wire([client, server], '10.94.0');
    client.powerOn();
    server.powerOn();
    server.setCurrentUser('Administrator');
    await server.executeCommand('net user bob Passw0rd! /add');
    await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -C bob@lab -f ~/id");
    await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -C ca@lab -f ~/ca");
    const authority = (await client.executeCommand('cut -d" " -f1,2 ~/ca.pub')).trim();
    await server.executeCommand(`echo ${authority}> C:\\ProgramData\\ssh\\ca.pub`);
    return { client, server };
  }

  const SSH = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id bob@10.94.0.20 whoami';

  async function prepend(server: WindowsPC, directive: string): Promise<void> {
    await server.executeCommand(`echo ${directive}> C:\\sshd_config.new`);
    await server.executeCommand('type C:\\ProgramData\\ssh\\sshd_config>> C:\\sshd_config.new');
    await server.executeCommand('copy /y C:\\sshd_config.new C:\\ProgramData\\ssh\\sshd_config');
  }

  async function restart(server: WindowsPC): Promise<void> {
    await server.executeCommand('net stop sshd');
    await server.executeCommand('net start sshd');
  }

  it('TrustedUserCAKeys admet un certificat de l\'AC', async () => {
    const { client, server } = await lab();
    await prepend(server, 'TrustedUserCAKeys C:/ProgramData/ssh/ca.pub');
    await restart(server);
    await client.executeCommand('ssh-keygen -q -s ~/ca -I bob-key -n bob ~/id.pub');

    expect((await client.executeCommand(SSH)).trim().toLowerCase()).toContain('bob');
  }, 120_000);

  it('sans TrustedUserCAKeys le certificat est refuse', async () => {
    const { client, server } = await lab();
    await restart(server);
    await client.executeCommand('ssh-keygen -q -s ~/ca -I bob-key -n bob ~/id.pub');

    expect(await client.executeCommand(SSH)).toContain('Permission denied');
  }, 120_000);

  it('RevokedKeys refuse un certificat dont la serie est dans la KRL', async () => {
    const { client, server } = await lab();
    await prepend(server, 'TrustedUserCAKeys C:/ProgramData/ssh/ca.pub');
    await prepend(server, 'RevokedKeys C:/ProgramData/ssh/revoked.krl');
    await server.executeCommand('echo serial: 5-9 > C:\\spec.txt');
    await server.executeCommand('ssh-keygen -k -q -s C:\\ProgramData\\ssh\\ca.pub -f C:\\ProgramData\\ssh\\revoked.krl C:\\spec.txt');
    await restart(server);
    await client.executeCommand('ssh-keygen -q -s ~/ca -I bob-key -n bob -z 7 ~/id.pub');
    expect(await client.executeCommand(SSH)).toContain('Permission denied');

    await client.executeCommand('ssh-keygen -q -s ~/ca -I bob-key -n bob -z 20 ~/id.pub');
    expect((await client.executeCommand(SSH)).toLowerCase()).toContain('bob');
  }, 120_000);

  it('HostCertificate : le client verifie le certificat d\'hote du serveur Windows', async () => {
    const { client, server } = await lab();
    await server.executeCommand('ssh-keygen -q -t ed25519 -N "" -f C:\\hostca');
    await server.executeCommand('ssh-keygen -q -s C:\\hostca -h -I wsrv -n 10.94.0.20 C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub');
    await prepend(server, 'HostCertificate C:/ProgramData/ssh/ssh_host_ed25519_key-cert.pub');
    await prepend(server, 'TrustedUserCAKeys C:/ProgramData/ssh/ca.pub');
    await restart(server);
    const hostAuthority = (await server.executeCommand('type C:\\hostca.pub')).trim().split(' ').slice(0, 2).join(' ');
    await client.executeCommand(`mkdir -p ~/.ssh && printf '@cert-authority 10.94.0.20 %s\\n' '${hostAuthority}' > ~/.ssh/known_hosts`);
    await client.executeCommand('ssh-keygen -q -s ~/ca -I bob-key -n bob ~/id.pub');

    const out = await client.executeCommand('ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -i ~/id bob@10.94.0.20 whoami');
    expect(out.toLowerCase()).toContain('bob');
    expect(out).not.toContain('No ED25519 host key is known');
  }, 120_000);
});
