/*
 * Ce que la reference CLI FortiOS 7.6.7 (official_docs/forti-cli-ref-767.txt)
 * porte pour `config system dhcp server` et `execute dhcp lease-clear` et que
 * le FortiGate refusait : dns-server4 ; `config ip-range` / lease-time (« 0
 * means default lease time », range 300-8640000) ; reserved-address
 * `type option82` avec circuit-id, circuit-id-type, remote-id, remote-id-type
 * (hex|string) ; `execute dhcp lease-clear <ip-debut>-<ip-fin>`.
 *
 * Non source : le comparateur d'option 82 (une reservation est reconnue quand
 * ses identifiants non vides egalent ceux du relais) est la lecture la plus
 * simple de « match with DHCP option 82 » ; la reference ne le detaille pas.
 * Les identifiants qu'insere le relais du simulateur sont l'interface
 * d'entree (circuit-id) et le nom d'hote (remote-id).
 *
 * Avant le correctif chaque attribut etait refuse par la CLI : 8 des 11 cas
 * tombent (git stash de src/network). Passent des deux cotes les TEMOINS :
 * le bail du serveur sans lease-time de plage, le refus d'un lease-time de
 * plage hors bornes n'etant pas dans cette liste (il tombe), et un
 * circuit-id qui ne correspond pas, qui laisse le client dans la plage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { resetCounters, MACAddress, ETHERTYPE_IPV4, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }
const type = async (device: Terminal, lines: readonly string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
};

function recordReplies(port: Port): DHCPPacket[] {
  const seen: DHCPPacket[] = [];
  port.attachTap(({ direction, frame }) => {
    if (direction !== 'in' || frame.etherType !== ETHERTYPE_IPV4) return;
    const udp = (frame.payload as IPv4Packet).payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.payload instanceof DHCPPacket && udp.payload.op === 2) seen.push(udp.payload);
  });
  return seen;
}

async function direct(serverLines: readonly string[], rangeLines: readonly string[] = ['set start-ip 192.168.10.100', 'set end-ip 192.168.10.110']) {
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  const pc = new WindowsPC('windows-pc', 'PC', 0, 0);
  new Cable('up').connect(sw.getPort('eth0')!, fw.getPort('port2')!);
  new Cable('a').connect(pc.getPort('eth0')!, sw.getPort('eth1')!);
  const out = await type(fw, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 192.168.10.1',
    'set netmask 255.255.255.0', 'set lease-time 86400', ...serverLines,
    'config ip-range', 'edit 1', ...rangeLines, 'next', 'end', 'next', 'end',
  ]);
  return { fw, pc, out, replies: recordReplies(pc.getPort('eth0')!) };
}

const optionBytes = (packet: DHCPPacket, code: number): number[] => Array.from(packet.getOption(code) as Uint8Array).slice(1);

describe('serveur : dns-server4 et lease-time de plage', () => {
  it('dns-server1 a 4 sont offerts', async () => {
    const { pc, replies } = await direct(['set dns-server1 10.0.0.1', 'set dns-server2 10.0.0.2', 'set dns-server3 10.0.0.3', 'set dns-server4 10.0.0.4']);
    await pc.executeCommand('ipconfig /renew');
    const ack = replies.find(r => r.getMessageType() === 'DHCPACK')!;
    expect((ack.getOption(6) as string[]).map(String)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
  });

  it('WITNESS : sans lease-time de plage, le bail est celui du serveur', async () => {
    const { pc, replies } = await direct([]);
    await pc.executeCommand('ipconfig /renew');
    expect(replies.find(r => r.getMessageType() === 'DHCPACK')!.getOption(51)).toBe(86400);
  });

  it('le lease-time d une plage l emporte sur celui du serveur', async () => {
    const { pc, replies } = await direct([], ['set start-ip 192.168.10.100', 'set end-ip 192.168.10.110', 'set lease-time 1800']);
    await pc.executeCommand('ipconfig /renew');
    expect(replies.find(r => r.getMessageType() === 'DHCPACK')!.getOption(51)).toBe(1800);
  });

  it('un lease-time de plage sous 300 est refuse', async () => {
    const { out } = await direct([], ['set start-ip 192.168.10.100', 'set end-ip 192.168.10.110', 'set lease-time 100']);
    expect(out.join('\n')).toMatch(/range\[300-8640000\]/);
  });
});

describe('lease-clear', () => {
  it('efface les baux d une plage d adresses', async () => {
    const { fw, pc } = await direct([]);
    await pc.executeCommand('ipconfig /renew');
    expect(await fw.executeCommand('execute dhcp lease-list')).toMatch(/192\.168\.10\.1\d\d/);
    expect(await fw.executeCommand('execute dhcp lease-clear 192.168.10.100-192.168.10.110')).toBe('');
    expect(await fw.executeCommand('execute dhcp lease-list')).not.toMatch(/192\.168\.10\.1\d\d/);
  });

  it('une plage sans bail est signalee', async () => {
    const { fw } = await direct([]);
    expect(await fw.executeCommand('execute dhcp lease-clear 10.9.9.1-10.9.9.9')).toMatch(/no lease/);
  });
});

describe('reservation par option 82', () => {
  async function relayed(reservation: readonly string[], insert = true) {
    const router = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC1', -200, 0);
    const fw = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    new Cable('lan').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/1')!);
    new Cable('transit').connect(router.getPort('GigabitEthernet0/0')!, fw.getPort('port2')!);
    await type(router, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 192.168.20.1 255.255.255.0', 'ip helper-address 10.0.0.1', 'no shutdown', 'exit',
      ...(insert ? ['ip dhcp relay information option'] : []), 'end',
    ]);
    await type(fw, [
      'config system interface', 'edit port2', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
      'config router static', 'edit 1', 'set dst 192.168.20.0 255.255.255.0', 'set gateway 10.0.0.2', 'set device port2', 'next', 'end',
      'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 192.168.20.1', 'set netmask 255.255.255.0',
      'config ip-range', 'edit 1', 'set start-ip 192.168.20.100', 'set end-ip 192.168.20.110', 'next', 'end',
      'config reserved-address', 'edit 1', ...reservation, 'next', 'end', 'next', 'end',
    ]);
    await type(pc, ['ip link set eth0 up', 'dhclient eth0']);
    return /inet (\d+\.\d+\.\d+\.\d+)\//.exec(await pc.executeCommand('ip addr show eth0'))?.[1] ?? '';
  }

  it('un client relaye dont le circuit-id correspond recoit l adresse reservee', async () => {
    expect(await relayed(['set type option82', 'set circuit-id "GigabitEthernet0/1"', 'set ip 192.168.20.50'])).toBe('192.168.20.50');
  });

  it('le circuit-id peut etre ecrit en hexadecimal', async () => {
    const hex = Array.from('GigabitEthernet0/1', c => c.charCodeAt(0).toString(16)).join('');
    expect(await relayed(['set type option82', 'set circuit-id-type hex', `set circuit-id "${hex}"`, 'set ip 192.168.20.51'])).toBe('192.168.20.51');
  });

  it('le remote-id est le nom d hote du relais', async () => {
    expect(await relayed(['set type option82', 'set remote-id "R1"', 'set ip 192.168.20.52'])).toBe('192.168.20.52');
  });

  it('action block refuse le client relaye', async () => {
    expect(await relayed(['set type option82', 'set circuit-id "GigabitEthernet0/1"', 'set action block'])).toBe('');
  });

  it('WITNESS : un circuit-id qui ne correspond pas laisse le client dans la plage', async () => {
    expect(await relayed(['set type option82', 'set circuit-id "Gi9/9"', 'set ip 192.168.20.50'])).toMatch(/^192\.168\.20\.1[01]\d$/);
  });
});
void optionBytes;
