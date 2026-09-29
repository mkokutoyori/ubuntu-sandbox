/*
 * Une reservation DHCP d'un FortiGate (`config reserved-address`) doit suivre
 * la configuration : supprimee, elle cesse de servir ; modifiee, c'est la
 * nouvelle adresse qui sert ; quelle que soit l'ecriture du MAC, elle
 * s'applique ; un client qui detient encore une autre adresse la perd.
 *
 * L'AUTORITE :
 * - RFC 2131 §4.3.2 (INIT-REBOOT) : si l'adresse que le client redemande
 *   n'est pas correcte pour lui, le serveur doit repondre DHCPNAK, et le
 *   client repart de DHCPDISCOVER ;
 * - le schema FortiOS de `system dhcp server` / `reserved-address` (le
 *   module `fortios_system_dhcp_server` de la collection Ansible de Fortinet)
 *   : une reservation lie une adresse IP a un MAC. La documentation de
 *   Fortinet n'est pas joignable d'ici ; les libelles de refus du commit
 *   ne sont donc pas ceux d'un FortiOS capture.
 *
 * Ecrite a l'aveugle. Le laboratoire est un FortiGate, un switch et deux
 * postes Linux sur le meme segment. 12 des 16 cas tombent avant le
 * correctif. Passent des deux cotes les TEMOINS : la reservation servie a la
 * premiere configuration, l'adresse reservee dans la plage qui n'est pas
 * offerte a un autre poste, le MAC ecrit en majuscules (la comparaison ignore
 * la casse) et l'adresse reservee elle-meme qui reste acquittee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

interface Lab { readonly fgt: FortiGate; readonly pc1: LinuxPC; readonly pc2: LinuxPC; readonly mac1: string }

async function lab(): Promise<Lab> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  const pc1 = new LinuxPC('linux-pc', 'PC1', -200, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', -200, 100);
  new Cable('up').connect(sw.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('a').connect(pc1.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('b').connect(pc2.getPort('eth0')!, sw.getPort('eth2')!);
  await type(pc1, ['ip link set eth0 up']);
  await type(pc2, ['ip link set eth0 up']);
  await type(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"',
    'set default-gateway 192.168.10.1', 'set netmask 255.255.255.0',
    'config ip-range', 'edit 1',
    'set start-ip 192.168.10.100', 'set end-ip 192.168.10.110',
    'next', 'end', 'next', 'end',
  ]);
  return { fgt, pc1, pc2, mac1: pc1.getPort('eth0')!.getMAC().toString() };
}

function reserve(mac: string, ip: string, id = 1): string[] {
  return [
    'config system dhcp server', 'edit 1', 'config reserved-address', `edit ${id}`,
    `set ip ${ip}`, `set mac ${mac}`, 'next', 'end', 'next', 'end',
  ];
}

async function address(pc: LinuxPC): Promise<string> {
  const text = await pc.executeCommand('ip addr show eth0');
  return /inet (\d+\.\d+\.\d+\.\d+)\//.exec(text)?.[1] ?? '';
}

async function rebind(pc: LinuxPC): Promise<string> {
  await pc.executeCommand('dhclient -r eth0');
  await pc.executeCommand('dhclient -v eth0');
  return address(pc);
}

describe('a reservation follows the configuration', () => {
  it('is served on the first configuration — WITNESS', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await type(fgt, reserve(mac1, '192.168.10.50'));

    expect(await rebind(pc1)).toBe('192.168.10.50');
  });

  it('a reserved address inside the range is not offered to another client — WITNESS', async () => {
    const { fgt, pc1, pc2 } = await lab();
    await type(fgt, reserve('02:aa:bb:cc:dd:ee', '192.168.10.100'));

    expect(await rebind(pc1)).not.toBe('192.168.10.100');
    expect(await rebind(pc2)).not.toBe('192.168.10.100');
  });

  it('a deleted reservation stops serving', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await type(fgt, reserve(mac1, '192.168.10.50'));
    expect(await rebind(pc1)).toBe('192.168.10.50');
    await type(fgt, ['config system dhcp server', 'edit 1', 'config reserved-address', 'delete 1', 'end', 'end']);

    expect(await rebind(pc1)).toMatch(/^192\.168\.10\.1(0\d|10)$/);
  });

  it('an edited reservation serves the new address', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await type(fgt, reserve(mac1, '192.168.10.50'));
    expect(await rebind(pc1)).toBe('192.168.10.50');
    await type(fgt, reserve(mac1, '192.168.10.60'));

    expect(await rebind(pc1)).toBe('192.168.10.60');
  });

  it('a deleted DHCP server stops serving its reservations', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await type(fgt, reserve(mac1, '192.168.10.50'));
    await type(fgt, ['config system dhcp server', 'delete 1', 'end']);
    await type(fgt, [
      'config system dhcp server', 'edit 1', 'set interface "port2"',
      'set default-gateway 192.168.10.1', 'set netmask 255.255.255.0',
      'config ip-range', 'edit 1', 'set start-ip 192.168.10.100', 'set end-ip 192.168.10.110',
      'next', 'end', 'next', 'end',
    ]);

    expect(await rebind(pc1)).toMatch(/^192\.168\.10\.1(0\d|10)$/);
  });
});

describe('the MAC is read however it is written', () => {
  it('upper case', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await type(fgt, reserve(mac1.toUpperCase(), '192.168.10.50'));

    expect(await rebind(pc1)).toBe('192.168.10.50');
  });

  it('dashes', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await type(fgt, reserve(mac1.replace(/:/g, '-'), '192.168.10.50'));

    expect(await rebind(pc1)).toBe('192.168.10.50');
  });

  it('dotted quads', async () => {
    const { fgt, pc1, mac1 } = await lab();
    const dotted = mac1.replace(/:/g, '').replace(/(.{4})/g, '$1.').replace(/\.$/, '');
    await type(fgt, reserve(dotted, '192.168.10.50'));

    expect(await rebind(pc1)).toBe('192.168.10.50');
  });
});

describe('a client holding another address moves to its reservation', () => {
  it('the renewal of the old address is refused and the client restarts', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await pc1.executeCommand('dhclient -v eth0');
    expect(await address(pc1)).toBe('192.168.10.100');
    await type(fgt, reserve(mac1, '192.168.10.50'));
    await pc1.executeCommand('dhclient -v eth0');

    expect(await address(pc1)).toBe('192.168.10.50');
  });

  it('the lease list keeps one line for the client, on its reserved address', async () => {
    const { fgt, pc1, mac1 } = await lab();
    await pc1.executeCommand('dhclient -v eth0');
    await type(fgt, reserve(mac1, '192.168.10.50'));
    await pc1.executeCommand('dhclient -v eth0');
    const rows = (await fgt.executeCommand('execute dhcp lease-list')).split('\n').filter(line => line.includes(mac1));

    expect(rows.length).toBe(1);
    expect(rows[0]).toContain('192.168.10.50');
  });

  it('the server answers DHCPNAK to a reserved client asking for another address', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('192.168.10.1');
    server.createPool('lan');
    server.configurePoolNetwork('lan', '192.168.10.0', '255.255.255.0');
    server.enable();
    server.addStaticBinding('lan', '02:00:00:00:00:01', '192.168.10.50');

    const answer = server.processRequestWithNak({
      clientMAC: '02:00:00:00:00:01', xid: 7, requestedIP: '192.168.10.100',
      clientIdentifier: '0102000000000001',
    });

    expect(answer?.type).toBe('NAK');
  });

  it('the reserved address itself is still acknowledged — WITNESS', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('192.168.10.1');
    server.createPool('lan');
    server.configurePoolNetwork('lan', '192.168.10.0', '255.255.255.0');
    server.enable();
    server.addStaticBinding('lan', '02:00:00:00:00:01', '192.168.10.50');

    const answer = server.processRequestWithNak({
      clientMAC: '02:00:00:00:00:01', xid: 7, requestedIP: '192.168.10.50',
      clientIdentifier: '0102000000000001',
    });

    expect(answer?.type).toBe('ACK');
  });

  it('dropping a pool drops its static bindings', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('192.168.10.1');
    server.createPool('lan');
    server.configurePoolNetwork('lan', '192.168.10.0', '255.255.255.0');
    server.addStaticBinding('lan', '02:00:00:00:00:01', '192.168.10.50');
    server.deletePool('lan');

    expect(server.getStaticBindings('lan')).toEqual([]);
  });
});

describe('a reservation the server could not honour is refused at commit', () => {
  const refused = (out: readonly string[]): boolean => out.some(line => /Command fail/i.test(line));

  it('two MACs cannot hold one address', async () => {
    const { fgt, mac1 } = await lab();
    await type(fgt, reserve(mac1, '192.168.10.50', 1));
    const out = await type(fgt, reserve('02:aa:bb:cc:dd:ee', '192.168.10.50', 2));

    expect(refused(out)).toBe(true);
  });

  it('one MAC cannot hold two addresses', async () => {
    const { fgt, mac1 } = await lab();
    await type(fgt, reserve(mac1, '192.168.10.50', 1));
    const out = await type(fgt, reserve(mac1, '192.168.10.60', 2));

    expect(refused(out)).toBe(true);
  });

  it('an address outside the subnet of the server is refused', async () => {
    const { fgt } = await lab();
    const out = await type(fgt, reserve('02:aa:bb:cc:dd:ee', '10.9.9.9'));

    expect(refused(out)).toBe(true);
  });
});
