/*
 * RevokedHostKeys et le marqueur @revoked de known_hosts, sur le client Linux
 * comme sur le client Windows.
 *
 * L'AUTORITE : OpenSSH 8.9p1, `sshconnect.c` :
 * - `verify_host_key` : « Host key <type> <empreinte> revoked by file <f> »
 *   (error) puis echec « Host key verification failed. » quand la cle (ou
 *   le certificat) figure dans le fichier de RevokedHostKeys, liste de cles
 *   ou KRL ; fichier illisible : « Error checking host key … in revoked keys
 *   file … » et meme echec ;
 * - `check_host_key`, cas HOST_REVOKED : une ligne « @revoked <hotes> <cle> »
 *   de known_hosts donne la banniere « WARNING: REVOKED HOST KEY DETECTED! »,
 *   « The <type> host key for <hote> is marked as revoked. » …, puis avec
 *   StrictHostKeyChecking different de « no » « <type> host key for <hote> was
 *   revoked and you have requested strict checking. » et l'echec ; avec « no »
 *   la connexion continue apres la banniere.
 * Aujourd'hui @revoked est lu puis ignore : la cle revoquee reste acceptee.
 *
 * Ecrite contre ces sources, avant l'implantation. 9 des 11 cas tombent avant.
 * Passent des deux cotes les TEMOINS : une cle absente du fichier de
 * revocation ne revoque rien (Linux, Windows).
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

interface Platform {
  readonly name: 'linux' | 'windows';
  readonly write: (device: LinuxPC | WindowsPC, path: string, content: string) => Promise<void>;
  readonly revokedPath: string;
  readonly knownHosts: string;
}

const LINUX: Platform = {
  name: 'linux', revokedPath: '/home/user/revoked.pub', knownHosts: '~/.ssh/known_hosts',
  write: async (device, path, content) => { await device.executeCommand(`sh -c 'printf "%s\\n" "${content}" > ${path}'`); },
};
const WINDOWS: Platform = {
  name: 'windows', revokedPath: 'C:/revoked.pub', knownHosts: 'C:\\Users\\User\\.ssh\\known_hosts',
  write: async (device, path, content) => { await device.executeCommand(`echo ${content}> ${path.replace(/\//g, '\\')}`); },
};

async function lab(platform: Platform) {
  const client = platform.name === 'linux' ? new LinuxPC('linux-pc', 'PC1', 0, 0) : new WindowsPC('windows-pc', 'WIN');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  [client, server].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0] as never, sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(`10.98.0.${10 + index * 10}`), mask);
  });
  client.powerOn();
  server.powerOn();
  await client.executeCommand(platform.name === 'linux' ? 'mkdir -p ~/.ssh' : 'mkdir C:\\Users\\User\\.ssh');
  await server.executeCommand('useradd -m -s /bin/bash bob');
  await server.executeCommand('echo bob:secret | chpasswd');
  const hostKey = (await server.executeCommand('cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub')).trim();
  return { client, server, hostKey };
}

const SSH = (extra: string, strict = 'no') =>
  `ssh -o BatchMode=yes -o PasswordAuthentication=no -o StrictHostKeyChecking=${strict} ${extra} bob@10.98.0.20 true`;

for (const platform of [LINUX, WINDOWS]) {
  describe(`client ${platform.name}`, () => {
    it('TEMOIN: une cle absente du fichier de revocation ne revoque rien', async () => {
      const { client } = await lab(platform);
      await platform.write(client, platform.revokedPath, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKeyAAAA');
      const out = await client.executeCommand(SSH(`-o RevokedHostKeys=${platform.revokedPath}`));
      expect(out).not.toContain('revoked');
    }, 120_000);

    it('RevokedHostKeys refuse une cle d\'hote listee', async () => {
      const { client, hostKey } = await lab(platform);
      await platform.write(client, platform.revokedPath, hostKey);
      const out = await client.executeCommand(SSH(`-o RevokedHostKeys=${platform.revokedPath}`));
      expect(out).toMatch(/Host key ED25519 SHA256:\S+ revoked by file \S*revoked\.pub/);
      expect(out).toContain('Host key verification failed.');
    }, 120_000);

    it('un fichier de revocation illisible refuse aussi la connexion', async () => {
      const { client } = await lab(platform);
      const out = await client.executeCommand(SSH('-o RevokedHostKeys=/nonexistent/revoked'));
      expect(out).toMatch(/Error checking host key ED25519 SHA256:\S+ in revoked keys file \/nonexistent\/revoked/);
      expect(out).toContain('Host key verification failed.');
    }, 120_000);

    it('@revoked dans known_hosts refuse la cle avec la banniere d\'OpenSSH', async () => {
      const { client, hostKey } = await lab(platform);
      await platform.write(client, platform.knownHosts, `@revoked 10.98.0.20 ${hostKey}`);
      const out = await client.executeCommand(SSH('', 'yes'));
      expect(out).toContain('WARNING: REVOKED HOST KEY DETECTED!');
      expect(out).toContain('The ED25519 host key for 10.98.0.20 is marked as revoked.');
      expect(out).toContain('ED25519 host key for 10.98.0.20 was revoked and you have requested strict checking.');
      expect(out).toContain('Host key verification failed.');
    }, 120_000);
  });
}

describe('cas communs', () => {
  it('une KRL de cles revoque la cle d\'hote', async () => {
    const { client, hostKey } = await lab(LINUX);
    await client.executeCommand(`sh -c 'printf "%s\\n" "${hostKey}" > ~/spec.txt'`);
    await client.executeCommand('ssh-keygen -q -k -f ~/hosts.krl ~/spec.txt');
    const out = await client.executeCommand(SSH('-o RevokedHostKeys=/home/user/hosts.krl'));
    expect(out).toMatch(/Host key ED25519 SHA256:\S+ revoked by file \/home\/user\/hosts\.krl/);
  }, 120_000);

  it('RevokedHostKeys dans ~/.ssh/config', async () => {
    const { client, hostKey } = await lab(LINUX);
    await LINUX.write(client, LINUX.revokedPath, hostKey);
    await client.executeCommand('mkdir -p ~/.ssh');
    await client.executeCommand("sh -c 'printf \"Host 10.98.0.20\\n    RevokedHostKeys ~/revoked.pub\\n\" > ~/.ssh/config'");
    expect(await client.executeCommand(SSH(''))).toContain('revoked by file /home/user/revoked.pub');
  }, 120_000);

  it('@revoked avec StrictHostKeyChecking=no affiche la banniere puis continue', async () => {
    const { client, hostKey } = await lab(LINUX);
    await LINUX.write(client, LINUX.knownHosts, `@revoked 10.98.0.20 ${hostKey}`);
    const out = await client.executeCommand("ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o PasswordAuthentication=no bob@10.98.0.20 true");
    expect(out).toContain('WARNING: REVOKED HOST KEY DETECTED!');
    expect(out).not.toContain('Host key verification failed.');
  }, 120_000);
});
