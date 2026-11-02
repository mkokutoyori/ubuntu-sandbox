/**
 * `config system arp-table` (id, interface, ip, mac) et `config system proxy-arp` (id, interface, ip, end-ip) -- FortiOS CLI Reference 7.4.12 pp.1438 et 1898.
 * L'entree ARP est STATIQUE : elle apparait dans `get system arp`, sert de voisin sans demande ARP et disparait avec `delete`. Une entree proxy-ARP fait
 * repondre l'interface aux demandes ARP pour l'adresse (ou la plage ip..end-ip) : un client voisin la resout vers le MAC du pare-feu. Les deux reposent sur ce
 * que le pare-feu avait deja (ArpService.setStatic, ProxyArpTable que les VIP et les pools utilisent) ; `ArpService.removeStatic` s'ajoute pour retirer.
 * Mesure de depart : « unknown configuration path » pour les deux ; 3 des 6 cas tombent avant (entree visible, refus sans interface, adresse de la plage resolue) ; les 3 autres sont des temoins qui passent des deux cotes (suppression d'une entree inconnue, client sans proxy-ARP, adresse hors plage).
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab() {
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & { getPort(name: string): { getMAC(): { toString(): string } } };
  pc.powerOn();
  new Cable('c').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  await type(fw, ['config system interface', 'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next', 'end']);
  await type(pc, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);
  return { pc, fw };
}

describe('system arp-table', () => {
  it('une entree statique apparait dans get system arp', async () => {
    const { fw } = await lab();
    await type(fw, ['config system arp-table', 'edit 1', 'set interface "port1"', 'set ip 192.168.1.50', 'set mac 00:11:22:33:44:55', 'next', 'end']);
    const table = await fw.executeCommand('get system arp');
    expect(table).toContain('192.168.1.50');
    expect(table.toLowerCase()).toContain('00:11:22:33:44:55');
  });

  it('delete retire l entree', async () => {
    const { fw } = await lab();
    await type(fw, ['config system arp-table', 'edit 1', 'set interface "port1"', 'set ip 192.168.1.50', 'set mac 00:11:22:33:44:55', 'next', 'end']);
    await type(fw, ['config system arp-table', 'delete 1', 'end']);
    expect(await fw.executeCommand('get system arp')).not.toContain('192.168.1.50');
  });

  it('une entree sans interface est refusee', async () => {
    const { fw } = await lab();
    await type(fw, ['config system arp-table', 'edit 1', 'set ip 192.168.1.50']);
    const reply = await fw.executeCommand('next');
    await fw.executeCommand('end');
    expect(reply).toContain('needs an interface');
  });
});

describe('system proxy-arp', () => {
  const resolved = async (configure: boolean, target: string) => {
    const { pc, fw } = await lab();
    if (configure) await type(fw, ['config system proxy-arp', 'edit 1', 'set interface "port1"', 'set ip 192.168.1.200', 'set end-ip 192.168.1.205', 'next', 'end']);
    await pc.executeCommand(`ping -c 1 -W 1 ${target}`);
    return { neighbour: await pc.executeCommand(`ip neigh show ${target}`), mac: fw.getPort('port1').getMAC().toString().toLowerCase() };
  };

  it('temoin : sans proxy-ARP personne ne repond', async () => {
    expect((await resolved(false, '192.168.1.200')).neighbour).not.toMatch(/lladdr/);
  });

  it('une adresse de la plage est resolue vers le MAC du pare-feu', async () => {
    const { neighbour, mac } = await resolved(true, '192.168.1.203');
    expect(neighbour.toLowerCase()).toContain(mac);
  });

  it('une adresse hors plage ne l est pas', async () => {
    expect((await resolved(true, '192.168.1.206')).neighbour).not.toMatch(/lladdr/);
  });
});
