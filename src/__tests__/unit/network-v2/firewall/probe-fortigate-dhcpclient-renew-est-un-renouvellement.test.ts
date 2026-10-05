/*
 * `execute interface dhcpclient-renew` renouvelle le bail comme le fait le
 * minuteur T1 : une requete RENEWING en unicast vers le serveur qui l'a
 * accorde, et les minuteries repartent de l'ACK.
 *
 * Mesure de depart, sur un FortiGate dont port1 est en `mode dhcp` face a un
 * serveur ISC (bail de 600 s) : la commande diffuse un DHCPREQUEST depuis
 * 0.0.0.0, `ciaddr` nul et l'option 50 remplie, la forme INIT-REBOOT, alors
 * que le minuteur T1 du MEME client emet la forme RENEWING. Une operation,
 * deux ecritures : le client partage avait le corps du renouvellement a
 * l'interieur de sa minuterie.
 *
 * L'AUTORITE — RFC 2131 §4.3.2, tableau 5 : en RENEWING, `ciaddr` porte
 * l'adresse du client, l'option 50 et l'option 54 sont absentes ; §4.4.5 : la
 * requete est un unicast au serveur ; §4.4.5 encore : un DHCPNAK ramene le
 * client a INIT, qui recommence par un DISCOVER. La phrase de la commande
 * elle-meme, `renewing dhcp lease on port1`, est celle de la reference CLI
 * et ne change pas. Ce que la vraie commande envoie n'est pas attesté par une
 * source atteignable d'ici : la RFC tranche la forme du renouvellement.
 *
 * Ecrite a l'aveugle. Le temps est virtuel : le bail dure 600 s, T1 tombe a
 * 300 s. 4 des 8 cas tombent avant (git stash push -- src/network) : la
 * destination, l'adresse source et `ciaddr`, l'ACK en unicast, et le serveur
 * silencieux — la requete diffusee y faisait repartir un DISCOVER. Passent des
 * deux cotes : la phrase de la commande et le bail tenu (TEMOIN), la commande
 * refusee sur une interface qui n'est pas cliente (TEMOIN), la reprise des
 * minuteries a partir de l'ACK, que le chemin INIT-REBOOT assurait aussi, et
 * le DHCPNAK suivi d'un DISCOVER, que ce chemin assurait par son repli.
 *
 * Trouve en chemin : en RENEWING le client ignorait un DHCPNAK (il ne lisait
 * que l'ACK) ; il l'enregistre maintenant, abandonne le bail et recommence a
 * INIT, au minuteur T1 comme a la commande, qui partagent le meme corps. Il
 * ignorait de meme le DHCPNAK en REBINDING (T2) ; ce cas se mesure dans
 * probe-fortigate-dhcp-traps.test.ts, et T1 comme T2 partagent maintenant la
 * reprise des minuteries a partir de l'ACK.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import {
  resetCounters, MACAddress, ETHERTYPE_IPV4,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

interface DhcpFrame {
  readonly direction: 'in' | 'out';
  readonly frame: EthernetFrame;
  readonly ip: IPv4Packet;
  readonly dhcp: DHCPPacket;
  readonly kind: string;
}

function recordDhcp(port: Port): DhcpFrame[] {
  const seen: DhcpFrame[] = [];
  port.attachTap(({ direction, frame }) => {
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || !(udp.payload instanceof DHCPPacket)) return;
    seen.push({ direction, frame, ip, dhcp: udp.payload, kind: udp.payload.getMessageType() ?? '?' });
  });
  return seen;
}

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };

async function elapse(seconds: number): Promise<void> {
  clock.advance(seconds * 1000);
  await settle();
}

const ISC_CONFIG = "printf 'default-lease-time 600;\\nmax-lease-time 600;\\nsubnet 203.0.113.0 netmask 255.255.255.0 {\\n  range 203.0.113.50 203.0.113.60;\\n  option routers 203.0.113.1;\\n}\\n' > /etc/dhcp/dhcpd.conf";

async function lab() {
  const server = new LinuxServer('linux-server', 'ISP', -200, 0);
  await type(server, ['ip addr add 203.0.113.1/24 dev eth0', 'ip link set eth0 up', ISC_CONFIG, 'systemctl restart isc-dhcp-server']);
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  new Cable('wan').connect(server.getPort('eth0')!, fgt.getPort('port1')!);
  const seen = recordDhcp(server.getPort('eth0')!);
  await type(fgt, ['config system interface', 'edit port1', 'set mode dhcp', 'next', 'end']);
  const serverMac = server.getPort('eth0')!.getMAC().toString();
  const routes = () => fgt.executeCommand('get router info routing-table all');
  return { server, fgt, seen, serverMac, routes };
}

const requestsSince = (seen: DhcpFrame[], from: number): DhcpFrame[] =>
  seen.slice(from).filter(frame => frame.kind === 'DHCPREQUEST' && frame.direction === 'in');

describe('execute interface dhcpclient-renew', () => {
  it('prints the reference sentence and keeps the address — WITNESS', async () => {
    const { fgt, routes } = await lab();
    const out = await fgt.executeCommand('execute interface dhcpclient-renew port1');

    expect(out).toBe('renewing dhcp lease on port1');
    expect(await routes()).toContain('203.0.113.0/24 is directly connected, port1');
  });

  it('sends a REQUEST in unicast to the server that granted the lease', async () => {
    const { fgt, seen, serverMac } = await lab();
    const before = seen.length;
    await fgt.executeCommand('execute interface dhcpclient-renew port1');
    const [request] = requestsSince(seen, before);

    expect(request).toBeDefined();
    expect(request.ip.destinationIP.toString()).toBe('203.0.113.1');
    expect(request.frame.dstMAC.toString()).toBe(serverMac);
  });

  it('writes the held address as ciaddr and as source, without option 50 or 54', async () => {
    const { fgt, seen } = await lab();
    const before = seen.length;
    await fgt.executeCommand('execute interface dhcpclient-renew port1');
    const [request] = requestsSince(seen, before);

    expect(request.dhcp.ciaddr).toBe('203.0.113.50');
    expect(request.ip.sourceIP.toString()).toBe('203.0.113.50');
    expect(request.dhcp.getOption(50)).toBeUndefined();
    expect(request.dhcp.getOption(54)).toBeUndefined();
  });

  it('is answered by an ACK in unicast to the held address', async () => {
    const { fgt, seen } = await lab();
    const before = seen.length;
    await fgt.executeCommand('execute interface dhcpclient-renew port1');
    const ack = seen.slice(before).find(frame => frame.kind === 'DHCPACK');

    expect(ack).toBeDefined();
    expect(ack!.ip.destinationIP.toString()).toBe('203.0.113.50');
  });

  it('starts the lease timers over: the next T1 falls 300 s after the renewal, not after the first lease', async () => {
    const { fgt, seen } = await lab();
    await elapse(200);
    await fgt.executeCommand('execute interface dhcpclient-renew port1');
    const before = seen.length;
    await elapse(150);
    const earlyRequests = requestsSince(seen, before);
    await elapse(200);
    const lateRequests = requestsSince(seen, before);

    expect(earlyRequests).toEqual([]);
    expect(lateRequests.length).toBe(1);
  });

  it('keeps the lease held when the server stays silent, and does not start a DISCOVER', async () => {
    const { server, fgt, seen, routes } = await lab();
    await type(server, ['systemctl stop isc-dhcp-server']);
    const before = seen.length;
    const out = await fgt.executeCommand('execute interface dhcpclient-renew port1');

    expect(out).toBe('renewing dhcp lease on port1');
    expect(seen.slice(before).some(frame => frame.kind === 'DHCPDISCOVER')).toBe(false);
    expect(await routes()).toContain('203.0.113.0/24 is directly connected, port1');
  });

  it('starts over with a DISCOVER when the server refuses the renewal (DHCPNAK)', async () => {
    const { server, fgt, seen } = await lab();
    await type(server, [
      "printf 'authoritative;\\ndefault-lease-time 600;\\nmax-lease-time 600;\\nsubnet 203.0.113.0 netmask 255.255.255.0 {\\n  range 203.0.113.80 203.0.113.90;\\n  option routers 203.0.113.1;\\n}\\n' > /etc/dhcp/dhcpd.conf",
      'systemctl restart isc-dhcp-server',
      'rm -f /var/lib/dhcp/dhcpd.leases',
    ]);
    const before = seen.length;
    await fgt.executeCommand('execute interface dhcpclient-renew port1');
    const kinds = seen.slice(before).map(frame => frame.kind);

    expect(kinds).toContain('DHCPNAK');
    expect(kinds).toContain('DHCPDISCOVER');
  });

  it('is refused on an interface that is not a DHCP client — WITNESS', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute interface dhcpclient-renew port2');

    expect(out).toContain('port2 is not a DHCP client');
  });
});
