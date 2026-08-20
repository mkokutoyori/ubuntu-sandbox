/**
 * `copy … tftp:` transporte vraiment le fichier.
 *
 * Ce que la sonde mesure, et pourquoi elle est montée ainsi : le serveur
 * TFTP est une VRAIE machine cablée au routeur, et le fichier est relu
 * depuis le système de fichiers DU SERVEUR — pas depuis la valeur de
 * retour du client. Sans cela, une commande qui répond « [OK] » sans
 * qu'aucune trame ne parte passerait la sonde, ce qui est exactement le
 * défaut qu'elle existe pour attraper : la version précédente de cette
 * commande écrivait `Writing tftp: ... [OK]` et n'émettait rien.
 *
 * Le comptage des trames sur le câble est le témoin : il distingue « le
 * transfert a eu lieu » de « les deux bouts se sont entendus dans le
 * même processus ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TftpServer } from '@/network/tftp/TftpSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function serveur(ip: string) {
  const srv = new LinuxServer('linux-server', 'TFTP1');
  srv.configureInterface('eth0', new IPAddress(ip), new SubnetMask('255.255.255.0'));
  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
  const server = new TftpServer(srv, { fs, rootPath: '/srv/tftp' });
  server.start();
  return { srv, vfs, server };
}

async function routeurCable() {
  const r = new CiscoRouter('R1', 0, 0);
  const { srv, vfs, server } = serveur('10.0.0.10');
  const cable = new Cable('c1');
  cable.connect(r.getPort('GigabitEthernet0/0')!, srv.getPort('eth0')!);
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname R1-PROD');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
  await r.executeCommand('no shutdown');
  await r.executeCommand('end');
  // L'ARP du prochain saut : un ping fait le travail que ferait le
  // premier paquet du transfert, sans quoi la première trame partirait
  // en diffusion et le serveur ne la prendrait pas pour lui.
  await r.executeCommand('ping 10.0.0.10');
  return { r, srv, vfs, server, cable };
}

describe('copy running-config tftp: écrit sur le serveur', () => {
  it('le fichier existe VRAIMENT sur le serveur, avec le contenu du routeur', async () => {
    const { r, vfs } = await routeurCable();
    const out = await r.executeCommand('copy running-config tftp://10.0.0.10/R1-PROD.cfg');
    expect(out).toContain('bytes copied');
    const depose = vfs.readFile('/srv/tftp/R1-PROD.cfg');
    expect(depose).not.toBeNull();
    expect(depose).toContain('hostname R1-PROD');
    expect(depose).toContain('ip address 10.0.0.1 255.255.255.0');
  }, 30_000);

  it('des trames traversent le câble — ce n\'est pas une entente en mémoire', async () => {
    const { r, cable } = await routeurCable();
    const avant = cable.getStats().framesTransmitted;
    await r.executeCommand('copy running-config tftp://10.0.0.10/R1-PROD.cfg');
    expect(cable.getStats().framesTransmitted).toBeGreaterThan(avant);
  }, 30_000);

  it('un serveur injoignable ne répond pas « [OK] »', async () => {
    const { r } = await routeurCable();
    const out = await r.executeCommand('copy running-config tftp://10.0.0.99/x.cfg');
    expect(out).not.toContain('bytes copied');
    expect(out).toContain('%Error');
  }, 30_000);

  it('une URL sans adresse est refusée en nommant la forme attendue', async () => {
    const { r } = await routeurCable();
    const out = await r.executeCommand('copy running-config tftp:');
    expect(out).toContain('tftp://<address>/<filename>');
  }, 30_000);
});

describe('copy tftp: … relit depuis le serveur', () => {
  it('`copy tftp: running-config` applique VRAIMENT la configuration reçue', async () => {
    const { r, vfs } = await routeurCable();
    vfs.writeFile('/srv/tftp/depuis-serveur.cfg',
      'hostname VENU-DU-RESEAU\n', 1000, 1000, 0o022);
    const out = await r.executeCommand('copy tftp://10.0.0.10/depuis-serveur.cfg running-config');
    expect(out).toContain('bytes copied');
    expect(await r.executeCommand('show running-config')).toContain('hostname VENU-DU-RESEAU');
  }, 30_000);

  it('`copy tftp: flash:` dépose le fichier dans le VRAI flash:', async () => {
    const { r, vfs } = await routeurCable();
    vfs.writeFile('/srv/tftp/image.cfg', 'hostname DEPUIS-FLASH\n', 1000, 1000, 0o022);
    await r.executeCommand('copy tftp://10.0.0.10/image.cfg flash:recu.cfg');
    expect(await r.executeCommand('dir flash:')).toContain('recu.cfg');
    expect(await r.executeCommand('more flash:recu.cfg')).toContain('hostname DEPUIS-FLASH');
  }, 30_000);

  it('un fichier absent du serveur est rapporté, pas inventé', async () => {
    const { r } = await routeurCable();
    const out = await r.executeCommand('copy tftp://10.0.0.10/absent.cfg flash:recu-absent.cfg');
    expect(out).toContain('%Error');
    // `x.cfg` aurait été un motif trop lâche : `cpconfig-29xx.cfg`, que
    // le flash: porte d'usine, le contient. La sonde serait passée en
    // décrivant l'inverse de ce qu'elle mesure.
    expect(await r.executeCommand('dir flash:')).not.toContain('recu-absent.cfg');
  }, 30_000);
});

describe('un Catalyst copie comme un ISR', () => {
  async function switchCable() {
    const sw = new CiscoSwitch('SW1');
    const { srv, vfs } = serveur('10.0.0.10');
    const cable = new Cable('c2');
    cable.connect(sw.getPort('FastEthernet0/1')!, srv.getPort('eth0')!);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('hostname SW1-PROD');
    await sw.executeCommand('interface Vlan1');
    await sw.executeCommand('ip address 10.0.0.2 255.255.255.0');
    await sw.executeCommand('no shutdown');
    await sw.executeCommand('end');
    await sw.executeCommand('ping 10.0.0.10');
    return { sw, vfs };
  }

  it('`copy running-config tftp:` dépose la configuration du commutateur', async () => {
    const { sw, vfs } = await switchCable();
    const out = await sw.executeCommand('copy running-config tftp://10.0.0.10/SW1.cfg');
    expect(out).toContain('bytes copied');
    expect(vfs.readFile('/srv/tftp/SW1.cfg')).toContain('hostname SW1-PROD');
  }, 30_000);
});
