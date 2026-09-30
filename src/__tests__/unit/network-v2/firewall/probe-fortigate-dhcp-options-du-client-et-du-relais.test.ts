/*
 * Ce que la reference CLI du depot (official_docs/forti-cli-ref-60.txt,
 * FortiOS 6.0.4) porte sur DHCP et que le FortiGate refusait ou ignorait :
 *
 * - `config system dhcp server` : wifi-ac1 a 3 (option 138, RFC 5417),
 *   vci-match et `config vci-string` (« only DHCP requests with a matching
 *   VCI are served ») ;
 * - `config system interface`, mode dhcp : dhcp-client-identifier (option 61
 *   de ce que le client envoie) et dhcp-renew-time (« range[300-604800], 0
 *   means use the renew time provided by the server ») ;
 * - `config system interface`, relais : dhcp-relay-agent-option (option 82
 *   inseree par le relais, RFC 3046).
 *
 * Non source : le defaut `dhcp-relay-agent-option enable` est de memoire
 * (la reference n'en donne pas), la valeur envoyee par Windows en option 60
 * (« MSFT 5.0 ») est celle de Microsoft, jamais emise avant ce commit.
 *
 * Les attributs etaient refuses par la CLI ou sans effet sur le fil ; le
 * laboratoire lit donc ce que le cable porte (Port.attachTap). 7 des 12 cas
 * tombent avant le correctif (git stash de src/network). Passent des deux
 * cotes : « vci-match avec une autre chaine refuse Windows » (avant, la ligne
 * etait refusee et le laboratoire ne prouve que son propre refus), et les
 * TEMOINS (un serveur sans vci-match sert Windows et Linux ; un
 * relais sans l'option ne l'insere pas ; un client sans identifiant custom
 * n'emet pas l'option 61).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

function record(port: Port, direction: 'in' | 'out'): DHCPPacket[] {
  const seen: DHCPPacket[] = [];
  port.attachTap(({ direction: way, frame }) => {
    if (way !== direction || frame.etherType !== ETHERTYPE_IPV4) return;
    const udp = (frame.payload as IPv4Packet).payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.payload instanceof DHCPPacket) seen.push(udp.payload);
  });
  return seen;
}

const bytesOf = (value: unknown): number[] => Array.from(value as Uint8Array).slice(1);

async function serverLab(server: readonly string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const lin = new LinuxPC('linux-pc', 'LIN', 0, 0);
  new Cable('up').connect(sw.getPort('eth0')!, fw.getPort('port2')!);
  new Cable('w').connect(win.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('l').connect(lin.getPort('eth0')!, sw.getPort('eth2')!);
  await type(lin, ['ip link set eth0 up']);
  await type(fw, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 192.168.10.1',
    'set netmask 255.255.255.0', ...server,
    'config ip-range', 'edit 1', 'set start-ip 192.168.10.100', 'set end-ip 192.168.10.120', 'next', 'end', 'next', 'end',
  ]);
  return { fw, win, lin, replies: record(win.getPort('eth0')!, 'in') };
}

const linuxAddress = async (pc: LinuxPC): Promise<string> =>
  /inet (\d+\.\d+\.\d+\.\d+)\//.exec(await pc.executeCommand('ip addr show eth0'))?.[1] ?? '';

describe('serveur : wifi-ac et vci-match', () => {
  it('wifi-ac1 a 3 sont offerts en option 138', async () => {
    const { win, replies } = await serverLab(['set wifi-ac1 10.1.1.1', 'set wifi-ac2 10.1.1.2', 'set wifi-ac3 10.1.1.3']);
    await win.executeCommand('ipconfig /renew');
    const ack = replies.find(r => r.getMessageType() === 'DHCPACK')!;
    expect(bytesOf(ack.getOption(138))).toEqual([10, 1, 1, 1, 10, 1, 1, 2, 10, 1, 1, 3]);
  });

  it('WITNESS : sans vci-match, Windows et Linux sont servis', async () => {
    const { win, lin } = await serverLab([]);
    expect(await win.executeCommand('ipconfig /renew')).toMatch(/IPv4 Address[ .]*: 192\.168\.10\.1/);
    await lin.executeCommand('dhclient eth0');
    expect(await linuxAddress(lin)).toMatch(/^192\.168\.10\.1/);
  });

  it('vci-match avec « MSFT 5.0 » sert Windows et refuse Linux', async () => {
    const { win, lin } = await serverLab([
      'set vci-match enable', 'config vci-string', 'edit "MSFT 5.0"', 'next', 'end']);
    expect(await win.executeCommand('ipconfig /renew')).toMatch(/IPv4 Address[ .]*: 192\.168\.10\.1/);
    await lin.executeCommand('dhclient eth0');
    expect(await linuxAddress(lin)).toBe('');
  });

  it('vci-match avec une autre chaine refuse Windows', async () => {
    const { win } = await serverLab([
      'set vci-match enable', 'config vci-string', 'edit "android-dhcp"', 'next', 'end']);
    expect(await win.executeCommand('ipconfig /renew')).not.toMatch(/IPv4 Address[ .]*: 192\.168\.10\.1/);
  });

  it('Windows emet l option 60 « MSFT 5.0 » sur le fil', async () => {
    const fw = await serverLab([]);
    const sent = record(fw.win.getPort('eth0')!, 'out');
    await fw.win.executeCommand('ipconfig /renew');
    expect(sent.find(p => p.getMessageType() === 'DHCPDISCOVER')?.getOption(60)).toBe('MSFT 5.0');
  });
});

async function clientLab(clientLines: readonly string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FW-C', 0, 0);
  const srv = new LinuxServer('linux-server', 'DHCP', 0, 0);
  new Cable('c').connect(fw.getPort('wan1')!, srv.getPort('eth0')!);
  await type(srv, [
    'ip link set eth0 up', 'ip addr add 172.16.0.1/24 dev eth0',
    `printf 'authoritative;\\ndefault-lease-time 3600;\\nmax-lease-time 7200;\\nsubnet 172.16.0.0 netmask 255.255.255.0 {\\n  range 172.16.0.100 172.16.0.110;\\n}\\n' > /etc/dhcp/dhcpd.conf`,
    'systemctl start isc-dhcp-server',
  ]);
  const sent = record(fw.getPort('wan1')!, 'out');
  const out = await type(fw, ['config system interface', 'edit wan1', 'set mode dhcp', ...clientLines, 'next', 'end']);
  return { fw, srv, sent, out };
}

describe('client : dhcp-client-identifier et dhcp-renew-time', () => {
  it('WITNESS : sans identifiant, le client n emet pas l option 61 (implicite par chaddr)', async () => {
    const { sent } = await clientLab([]);
    const discover = sent.find(p => p.getMessageType() === 'DHCPDISCOVER');
    expect(discover).toBeDefined();
    expect(discover!.getOption(61)).toBeUndefined();
  });

  it('dhcp-client-identifier est l option 61 envoyee', async () => {
    const { sent } = await clientLab(['set dhcp-client-identifier "fw-edge-01"']);
    expect(sent.find(p => p.getMessageType() === 'DHCPDISCOVER')?.getOption(61)).toBe('fw-edge-01');
  });

  it('dhcp-renew-time impose T1 au bail obtenu', async () => {
    const { fw } = await clientLab(['set dhcp-renew-time 400']);
    const lease = (fw.getDhcp() as unknown as { client: { getState(i: string): { lease: { renewalTime: number } | null } } })
      .client.getState('wan1').lease;
    expect(lease?.renewalTime).toBe(400);
  });

  it('WITNESS : sans dhcp-renew-time, T1 est la moitie du bail (RFC 2131 §4.4.5)', async () => {
    const { fw } = await clientLab([]);
    const lease = (fw.getDhcp() as unknown as { client: { getState(i: string): { lease: { renewalTime: number } | null } } })
      .client.getState('wan1').lease;
    expect(lease?.renewalTime).toBe(1800);
  });

  it('dhcp-renew-time hors de 300-604800 est refuse', async () => {
    const { out } = await clientLab(['set dhcp-renew-time 100']);
    expect(out.join('\n')).toMatch(/range\[300-604800\]/);
  });
});

describe('relais : dhcp-relay-agent-option', () => {
  async function relayLab(option: readonly string[]) {
    const fw = new FortiGate('firewall-fortinet', 'FW-R', 0, 0);
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
    new Cable('lan').connect(pc.getPort('eth0')!, fw.getPort('port1')!);
    new Cable('wan').connect(srv.getPort('eth0')!, fw.getPort('wan1')!);
    await type(fw, [
      'config system interface',
      'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0',
      'set dhcp-relay-service enable', 'set dhcp-relay-ip "203.0.113.9"', ...option, 'next',
      'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    ]);
    await type(srv, [
      'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
      `printf 'authoritative;\\nsubnet 192.168.1.0 netmask 255.255.255.0 {\\n  range 192.168.1.100 192.168.1.110;\\n}\\nsubnet 203.0.113.0 netmask 255.255.255.0 {\\n}\\n' > /etc/dhcp/dhcpd.conf`,
      'systemctl start isc-dhcp-server',
    ]);
    const relayed = record(srv.getPort('eth0')!, 'in');
    await type(pc, ['ip link set eth0 up', 'dhclient eth0']);
    return { relayed };
  }

  it('WITNESS : sans l option, le relais n insere pas l option 82', async () => {
    const { relayed } = await relayLab(['set dhcp-relay-agent-option disable']);
    const discover = relayed.find(p => p.getMessageType() === 'DHCPDISCOVER');
    expect(discover).toBeDefined();
    expect(discover!.getOption(82)).toBeUndefined();
  });

  it('avec dhcp-relay-agent-option enable, le relais insere l option 82', async () => {
    const { relayed } = await relayLab(['set dhcp-relay-agent-option enable']);
    expect(relayed.find(p => p.getMessageType() === 'DHCPDISCOVER')?.getOption(82)).toBeDefined();
  });
});
