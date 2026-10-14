/**
 * Mesure de depart (etape 4b, clients IOS) : le serveur sshd de Linux et de Windows ignorait
 * `KexAlgorithms`, `HostKeyAlgorithms`, `Ciphers` et `MACs` de sshd_config — il offrait toujours
 * la liste par defaut, si bien qu'un client dont la liste est ancienne (un IOS 15) ne pouvait
 * pas etre servi meme quand l'administrateur l'avait autorise —, et `Match Address` n'etait pas
 * evalue a la connexion : `DenyUsers` dans un bloc `Match Address` ne refusait personne parce que
 * l'adresse du client n'arrivait jamais a la decision. Le serveur offre desormais la liste de sa
 * configuration (une cle d'hote RSA est creee dans /etc/ssh quand `ssh-rsa` est autorise) et
 * decide l'admission avec l'adresse du pair.
 *
 * Laboratoire : deux postes Linux (10.0.0.1 et 10.0.0.3) et un serveur (10.0.0.2) sur un
 * commutateur, compte alice. Sur les six cas, trois tombent avant la correction : la connexion
 * d'un client en liste ancienne apres autorisation, la cle d'hote RSA creee dans /etc/ssh et le refus
 * `Match Address` pour l'adresse visee ; trois passent des deux cotes et sont nommes : les temoins
 * « sans autorisation, le client en liste ancienne est refuse a la negociation » et « l'autre adresse
 * n'est pas touchee par le bloc Match », et la non-regression « le refus nomme l'offre du serveur,
 * sans liste ancienne » (le serveur n'offrait deja pas la liste ancienne).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let first: LinuxPC;
let second: LinuxPC;
let server: LinuxServer;

const LEGACY_CLIENT =
  '-o KexAlgorithms=diffie-hellman-group14-sha1 -o HostKeyAlgorithms=ssh-rsa -o Ciphers=aes128-cbc -o MACs=hmac-sha1';
const ssh = (options: string, command: string): string =>
  `sshpass -p pw ssh -o StrictHostKeyChecking=no ${options} alice@10.0.0.2 ${command}`;

const reloadWith = async (...lines: string[]): Promise<void> => {
  for (const line of lines) await server.executeCommand(`echo '${line}' | sudo tee -a /etc/ssh/sshd_config`);
  await server.executeCommand('sudo systemctl reload ssh');
};

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  first = new LinuxPC('linux-pc', 'A', 0, 0);
  second = new LinuxPC('linux-pc', 'C', 0, 0);
  server = new LinuxServer('linux-server', 'B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c0').connect(first.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[1]);
  new Cable('c2').connect(second.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  first.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  second.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  await server.executeCommand('sudo useradd -m alice');
  await server.executeCommand('echo "alice:pw" | sudo chpasswd');
});

describe('sshd decide ses algorithmes depuis sshd_config', () => {
  it('temoin : sans autorisation, le client en liste ancienne est refuse a la negociation', async () => {
    const out = await first.executeCommand(ssh(LEGACY_CLIENT, 'whoami'));
    expect(out).toMatch(/no matching key exchange method found/);
  });

  it('le refus de negociation nomme l\'offre du serveur, sans liste ancienne', async () => {
    const out = await first.executeCommand(ssh(LEGACY_CLIENT, 'whoami'));
    expect(out).toMatch(/Their offer: curve25519-sha256/);
    expect(out).not.toMatch(/Their offer:.*diffie-hellman-group14-sha1/);
  });

  it('une fois la liste ancienne autorisee, le client en liste ancienne se connecte', async () => {
    await reloadWith(
      'KexAlgorithms +diffie-hellman-group14-sha1',
      'HostKeyAlgorithms +ssh-rsa',
      'Ciphers +aes128-cbc',
      'MACs +hmac-sha1',
    );
    expect((await first.executeCommand(ssh(LEGACY_CLIENT, 'whoami'))).trim()).toBe('alice');
  });

  it('la cle d\'hote RSA est creee dans /etc/ssh quand ssh-rsa est autorise', async () => {
    expect(await server.executeCommand('ls /etc/ssh')).not.toContain('ssh_host_rsa_key');
    await reloadWith('HostKeyAlgorithms +ssh-rsa');
    await first.executeCommand(ssh('-o HostKeyAlgorithms=ssh-rsa', 'true'));
    expect(await server.executeCommand('ls /etc/ssh')).toContain('ssh_host_rsa_key');
  });
});

describe('Match Address est evalue avec l\'adresse du client', () => {
  it('l\'adresse visee par le bloc est refusee', async () => {
    await reloadWith('Match Address 10.0.0.1', '  DenyUsers alice');
    expect(await first.executeCommand(ssh('', 'whoami'))).toMatch(/Permission denied/);
  });

  it('temoin : l\'autre adresse n\'est pas touchee par le bloc', async () => {
    await reloadWith('Match Address 10.0.0.1', '  DenyUsers alice');
    expect((await second.executeCommand(ssh('', 'whoami'))).trim()).toBe('alice');
  });
});
