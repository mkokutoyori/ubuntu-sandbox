/*
 * L'option CertificateFile du client ssh, sur Linux comme sur Windows.
 *
 * L'AUTORITE : OpenSSH 8.9p1, `ssh.c` (load_public_identity_files) et
 * `sshconnect2.c` (pubkey_prepare, sign_and_send_pubkey) :
 * - un certificat listé par CertificateFile (ligne de commande, ssh_config)
 *   est lu depuis le chemin indiqué, quel que soit son nom ;
 * - des qu'un CertificateFile est configure, le « <identite>-cert.pub » par
 *   defaut n'est plus charge (`if (options.num_certificate_files != 0)
 *   continue;`), meme si le fichier indique est absent ;
 * - les certificats explicites passent en tete, avant les cles de l'agent et
 *   des fichiers ; la signature utilise la cle privee d'une identite dont la
 *   cle publique est celle du certificat ;
 * - sans cle privee correspondante, la signature echoue :
 *   « Load key "<fichier-certificat>": invalid format ».
 *
 * Ecrite contre ces sources, avant l'implantation. 8 des 10 cas tombent avant
 * (option ignoree : certificat de nom libre, ssh_config Linux et Windows, absence de chargement
 * par defaut sur Linux et Windows, et l'avertissement de signature). Passent
 * des deux cotes les TEMOINS : sans CertificateFile un certificat de nom libre
 * n'est pas utilise (Linux, Windows).
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
  readonly keyPath: string;
  readonly certificatePath: string;
  readonly conventionalCertificate: string;
  readonly identityOption: string;
  readonly configPath: string;
}

const LINUX: Platform = {
  name: 'linux', keyPath: '~/id', certificatePath: '~/mycert.pub', conventionalCertificate: '~/id-cert.pub',
  identityOption: '-i ~/id', configPath: '~/.ssh/config',
};
const WINDOWS: Platform = {
  name: 'windows', keyPath: 'C:\\id', certificatePath: 'C:/mycert.pub', conventionalCertificate: 'C:\\id-cert.pub',
  identityOption: '-i C:\\id', configPath: 'C:\\Users\\User\\.ssh\\config',
};

async function lab(platform: Platform) {
  const client = platform.name === 'linux' ? new LinuxPC('linux-pc', 'PC1', 0, 0) : new WindowsPC('windows-pc', 'WIN');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  [client, server].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0] as never, sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(`10.97.0.${10 + index * 10}`), mask);
  });
  client.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash bob');
  const win = platform.name === 'windows';
  const q = win ? '' : "''";
  await client.executeCommand(`ssh-keygen -q -t ed25519 -N ${win ? '""' : q} -C bob@lab -f ${platform.keyPath}`);
  const caPath = win ? 'C:\\ca' : '~/ca';
  await client.executeCommand(`ssh-keygen -q -t ed25519 -N ${win ? '""' : q} -C ca@lab -f ${caPath}`);
  const authority = win
    ? (await client.executeCommand('type C:\\ca.pub')).trim().split(' ').slice(0, 2).join(' ')
    : (await client.executeCommand('cut -d" " -f1,2 ~/ca.pub')).trim();
  await server.executeCommand(`sh -c 'echo "${authority}" > /etc/ssh/ca.pub'`);
  await server.executeCommand(`sh -c 'echo "TrustedUserCAKeys /etc/ssh/ca.pub" >> /etc/ssh/sshd_config'`);
  await server.executeCommand('systemctl restart ssh');
  await client.executeCommand(`ssh-keygen -q -s ${caPath} -I bob-key -n bob ${platform.keyPath}.pub`);
  await client.executeCommand(win
    ? `copy C:\\id-cert.pub ${platform.certificatePath.replace(/\//g, '\\')}`
    : 'cp ~/id-cert.pub ~/mycert.pub');
  await client.executeCommand(win ? 'del C:\\id-cert.pub' : 'rm ~/id-cert.pub');
  return { client, server };
}

const SSH = (platform: Platform, extra: string) =>
  `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o PasswordAuthentication=no ${platform.identityOption} ${extra} bob@10.97.0.20 whoami`;

for (const platform of [LINUX, WINDOWS]) {
  describe(`client ${platform.name}`, () => {
    it('TEMOIN: un certificat de nom libre, sans CertificateFile, n\'est pas utilise', async () => {
      const { client } = await lab(platform);
      expect(await client.executeCommand(SSH(platform, ''))).toContain('Permission denied');
    }, 120_000);

    it('CertificateFile en ligne de commande charge un certificat de nom libre', async () => {
      const { client } = await lab(platform);
      expect((await client.executeCommand(SSH(platform, `-o CertificateFile=${platform.certificatePath}`))).trim()).toBe('bob');
    }, 120_000);

    it('un CertificateFile configure supprime le <identite>-cert.pub par defaut', async () => {
      const { client } = await lab(platform);
      await client.executeCommand(platform.name === 'linux'
        ? 'cp ~/mycert.pub ~/id-cert.pub'
        : 'copy C:\\mycert.pub C:\\id-cert.pub');
      expect((await client.executeCommand(SSH(platform, ''))).trim()).toBe('bob');
      expect(await client.executeCommand(SSH(platform, '-o CertificateFile=/nonexistent-cert.pub'))).toContain('Permission denied');
    }, 120_000);
  });
}

describe('client linux, suite', () => {
  it('CertificateFile dans ~/.ssh/config', async () => {
    const { client } = await lab(LINUX);
    await client.executeCommand('mkdir -p ~/.ssh');
    await client.executeCommand("sh -c 'printf \"Host 10.97.0.20\\n    CertificateFile ~/mycert.pub\\n\" > ~/.ssh/config'");
    expect((await client.executeCommand(SSH(LINUX, ''))).trim()).toBe('bob');
  }, 120_000);

  it('sans cle privee correspondante, la signature echoue avec le texte d\'OpenSSH', async () => {
    const { client } = await lab(LINUX);
    await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/other");
    const out = await client.executeCommand('ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o PasswordAuthentication=no -i ~/other -o CertificateFile=~/mycert.pub bob@10.97.0.20 whoami');
    expect(out).toMatch(/Load key "\/home\/user\/mycert\.pub": invalid format/);
    expect(out).toContain('Permission denied');
  }, 120_000);
});

describe('scp', () => {
  it('scp -o CertificateFile transmet le certificat', async () => {
    const { client, server } = await lab(LINUX);
    await client.executeCommand('echo hello > ~/f.txt');
    const options = '-o BatchMode=yes -o StrictHostKeyChecking=no -o PasswordAuthentication=no -i ~/id';
    await client.executeCommand(`scp ${options} ~/f.txt bob@10.97.0.20:/tmp/denied.txt`);
    expect(await server.executeCommand('cat /tmp/denied.txt')).not.toContain('hello');
    await client.executeCommand(`scp ${options} -o CertificateFile=/home/user/mycert.pub ~/f.txt bob@10.97.0.20:/tmp/ok.txt`);
    expect(await server.executeCommand('cat /tmp/ok.txt')).toContain('hello');
  }, 120_000);
});

describe('client windows, suite', () => {
  it('CertificateFile dans le ssh_config de l\'utilisateur', async () => {
    const { client } = await lab(WINDOWS);
    await client.executeCommand('mkdir C:\\Users\\User\\.ssh');
    await client.executeCommand('echo Host 10.97.0.20> C:\\Users\\User\\.ssh\\config');
    await client.executeCommand('echo     CertificateFile C:/mycert.pub>> C:\\Users\\User\\.ssh\\config');
    expect((await client.executeCommand(SSH(WINDOWS, ''))).trim()).toBe('bob');
  }, 120_000);
});
