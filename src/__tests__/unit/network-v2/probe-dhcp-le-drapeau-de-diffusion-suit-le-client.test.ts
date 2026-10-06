/*
 * Le drapeau BROADCAST d'un DISCOVER ou d'un REQUEST est celui du client
 * reel : ISC dhclient le laisse a zero, le client Windows le pose, et un hote
 * recoit la reponse unicast d'un serveur avant de tenir l'adresse qu'elle lui
 * accorde.
 *
 * Mesure de depart, sur un poste Linux qui lance `dhclient eth0` : le
 * DISCOVER et le REQUEST portaient `flags=0x8000` — le drapeau d'un client
 * Windows —, si bien que tous les serveurs repondaient en diffusion et que la
 * branche « drapeau absent » du serveur (RFC 2131 §4.1 : reponse unicast a
 * l'adresse materielle du client et a l'adresse proposee) n'etait atteignable
 * que par une sonde fabriquee. Un tcpdump sur le poste montrait `Flags
 * [broadcast]` la ou ISC dhclient montre `Flags [none]`. Le drapeau remis a
 * zero, l'OFFER arrivait bien en unicast sur le fil mais l'hote le jetait : la
 * couche IP ne livre pas un paquet adresse a une IP qu'elle ne porte pas
 * encore.
 *
 * L'AUTORITE — RFC 2131 §4.1 : « If the broadcast bit is not set [...] the
 * server unicasts the DHCPOFFER and DHCPACK messages to the client's hardware
 * address and yiaddr », et §4.1 encore : le client qui ne sait pas recevoir un
 * unicast avant d'etre configure pose le bit. Que dhclient laisse le bit a zero
 * (option `bootp-broadcast-always` pour le forcer, dhclient.conf(5)) et que
 * Windows le pose sont la memoire de captures reelles ; aucune capture n'est
 * atteignable d'ici. Un dhclient recoit ces reponses par un socket LPF, avant
 * le filtre IP : c'est pourquoi un `iptables -P INPUT DROP` ne l'empeche pas
 * d'obtenir son bail.
 *
 * Ecrite a l'aveugle. Un poste Linux face a quatre serveurs : ISC, un routeur
 * Cisco, un FortiGate, un Windows Server ; un client Windows ; la politique
 * DROP ; deux clients sur un concentrateur ; un tiers sur le meme commutateur.
 * 11 des 18 cas tombent avant (git stash push -- src/network) : le drapeau
 * clair et la reponse unicast, contre les quatre serveurs ; le bail sous
 * `INPUT DROP`, ou la reponse diffusee passait par le filtre IP et s'y perdait ;
 * et les deux cas du tiers sur le commutateur — le second, un TEMOIN, ne tombe
 * que faute du reglage du drapeau qu'il utilise. Passent des deux cotes : les
 * quatre cas « prend l'adresse », que le drapeau pose servait par diffusion et
 * qui prouvent que chaque laboratoire est sain ; le TEMOIN Windows ; le TEMOIN
 * « la politique DROP coupe un ping » ; et les deux clients sur concentrateur,
 * non-regression de la reponse qui n'est pas pour eux.
 *
 * MISE A JOUR — le client Windows. « Windows le pose » etait une memoire de captures, et la
 * documentation de Microsoft dit autre chose : depuis Windows 7 (blog Team DHCP « DHCP broadcast
 * flag handling in Windows 7 », KB 2459530), le client emet ses quatre premiers DISCOVER avec le
 * drapeau a ZERO, ne le bascule a UN que si aucune OFFER ne vient, puis garde en memoire la valeur
 * qui a reussi comme point de depart de l'acquisition suivante (Vista le posait toujours). Le
 * poste Windows est donc repondu en unicast comme dhclient et un tiers sur un commutateur n'en voit
 * que D et R. 5 des 23 cas tombent avant (git stash push -- src/network) : le drapeau initial et la
 * reponse unicast, le tiers sur le commutateur, les trois cas de bascule ; le TEMOIN du client a
 * drapeau fixe passe des deux cotes. Limite : la documentation parle de quatre DISCOVER par valeur
 * a intervalles exponentiels ; le client du simulateur n'en emet qu'un par valeur, faute d'horloge
 * qui avance pendant l'attente.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Hub } from '@/network/devices/Hub';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { DHCPClient } from '@/network/dhcp/DHCPClient';
import type { DhcpServerChannel } from '@/network/dhcp/DhcpServerChannel';
import { createDefaultPoolConfig } from '@/network/dhcp/types';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask, ETHERTYPE_IPV4,
  type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

interface Seen {
  readonly direction: 'in' | 'out';
  readonly kind: string;
  readonly flags: number;
  readonly ipDestination: string;
  readonly macDestination: string;
}

function record(port: Port): Seen[] {
  const seen: Seen[] = [];
  port.attachTap(({ direction, frame }) => {
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || !(udp.payload instanceof DHCPPacket)) return;
    seen.push({
      direction, kind: udp.payload.getMessageType() ?? '?', flags: udp.payload.flags,
      ipDestination: ip.destinationIP.toString(), macDestination: frame.dstMAC.toString(),
    });
  });
  return seen;
}

const BROADCAST_FLAG = 0x8000;
const kinds = (seen: readonly Seen[], direction: 'in' | 'out', ...wanted: string[]): Seen[] =>
  seen.filter(entry => entry.direction === direction && wanted.includes(entry.kind));
const inet = async (device: Terminal): Promise<string> =>
  (await device.executeCommand('ip -4 addr show eth0')).split('\n').filter(line => line.includes('inet ')).join('|');

async function isc(): Promise<{ port: Port; address: string; server: LinuxServer }> {
  const server = new LinuxServer('linux-server', 'ISC');
  await type(server, [
    'ip addr add 10.9.0.1/24 dev eth0', 'ip link set eth0 up',
    "printf 'subnet 10.9.0.0 netmask 255.255.255.0 {\\n  range 10.9.0.100 10.9.0.110;\\n  option routers 10.9.0.1;\\n}\\n' > /etc/dhcp/dhcpd.conf",
    'systemctl restart isc-dhcp-server',
  ]);
  return { port: server.getPort('eth0')!, address: '10.9.0.100', server };
}

async function cisco(): Promise<{ port: Port; address: string }> {
  const router = new CiscoRouter('R1');
  await type(router, [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.8.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool P', 'network 10.8.0.0 255.255.255.0', 'default-router 10.8.0.1', 'exit', 'end',
  ]);
  return { port: router.getPort('GigabitEthernet0/0')!, address: '10.8.0.2' };
}

async function fortigate(): Promise<{ port: Port; address: string }> {
  const firewall = new FortiGate('firewall-fortinet', 'FGT');
  await type(firewall, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 10.7.0.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 10.7.0.1',
    'set netmask 255.255.255.0', 'config ip-range', 'edit 1', 'set start-ip 10.7.0.100',
    'set end-ip 10.7.0.110', 'next', 'end', 'next', 'end',
  ]);
  return { port: firewall.getPort('port2')!, address: '10.7.0.100' };
}

const powershell = (device: WindowsServer | WindowsPC) => PowerShellSubShell.create(device).subShell;
const runPowershell = async (shell: ReturnType<typeof powershell>, line: string) =>
  (await shell.processLine(line)).output.join('\n');

async function windowsServer(): Promise<{ port: Port; address: string }> {
  const server = new WindowsServer('SRV');
  server.setCurrentUser('Administrator');
  server.getPorts()[0].configureIP(new IPAddress('10.6.0.5'), new SubnetMask('255.255.255.0'));
  const shell = powershell(server);
  for (const line of [
    'Install-WindowsFeature -Name DHCP -IncludeManagementTools',
    'Add-DhcpServerv4Scope -Name "LAN" -StartRange 10.6.0.10 -EndRange 10.6.0.200 -SubnetMask 255.255.255.0 -State Active',
    'Set-DhcpServerv4OptionValue -ScopeId 10.6.0.0 -Router 10.6.0.1',
  ]) await runPowershell(shell, line);
  return { port: server.getPorts()[0], address: '10.6.0.10' };
}

const servers = [
  ['an ISC server', isc],
  ['a Cisco router', cisco],
  ['a FortiGate', fortigate],
  ['a Windows Server', windowsServer],
] as const;

async function linuxClient(serverPort: Port): Promise<{ client: LinuxPC; seen: Seen[] }> {
  const client = new LinuxPC('linux-pc', 'PC');
  new Cable('lab').connect(serverPort, client.getPort('eth0')!);
  const seen = record(client.getPort('eth0')!);
  await client.executeCommand('ip link set eth0 up');
  return { client, seen };
}

describe.each(servers)('a Linux client facing %s', (_label, makeServer) => {
  it('leaves the BROADCAST flag clear in its DISCOVER and its REQUEST', async () => {
    const { port } = await makeServer();
    const { client, seen } = await linuxClient(port);
    await client.executeCommand('dhclient eth0');

    const sent = kinds(seen, 'out', 'DHCPDISCOVER', 'DHCPREQUEST');
    expect(sent.map(entry => entry.kind)).toEqual(['DHCPDISCOVER', 'DHCPREQUEST']);
    expect(sent.map(entry => entry.flags)).toEqual([0, 0]);
  });

  it('is answered in unicast to its hardware address and to the offered address', async () => {
    const { port, address } = await makeServer();
    const { client, seen } = await linuxClient(port);
    await client.executeCommand('dhclient eth0');
    const mac = client.getPort('eth0')!.getMAC().toString();

    const replies = kinds(seen, 'in', 'DHCPOFFER', 'DHCPACK');
    expect(replies.map(entry => entry.kind)).toEqual(['DHCPOFFER', 'DHCPACK']);
    for (const reply of replies) {
      expect(reply.ipDestination).toBe(address);
      expect(reply.macDestination).toBe(mac);
    }
  });

  it('takes the address although the reply was not addressed to one it held', async () => {
    const { port, address } = await makeServer();
    const { client } = await linuxClient(port);
    await client.executeCommand('dhclient eth0');

    expect(await inet(client)).toContain(`${address}/24`);
  });
});

describe('a Windows client', () => {
  it('starts with the BROADCAST flag clear and is answered in unicast, like Windows 7 and later', async () => {
    const { port } = await windowsServer();
    const client = new WindowsPC('windows-pc', 'PC-WIN');
    new Cable('win').connect(port, client.getPorts()[0]);
    const seen = record(client.getPorts()[0]);
    const shell = powershell(client);
    await runPowershell(shell, 'ipconfig /release');
    await runPowershell(shell, 'ipconfig /renew');

    const sent = kinds(seen, 'out', 'DHCPDISCOVER', 'DHCPREQUEST');
    expect(sent.length).toBeGreaterThan(0);
    for (const entry of sent) expect(entry.flags).toBe(0);
    const replies = kinds(seen, 'in', 'DHCPOFFER', 'DHCPACK');
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) expect(reply.macDestination).toBe(client.getPorts()[0].getMAC().toString());
  });

  it('a third machine on the same switch sees only its broadcast requests, as with dhclient', async () => {
    const { port } = await windowsServer();
    const sw = new GenericSwitch('switch-generic', 'SW');
    new Cable('up').connect(port, sw.getPorts()[0]);
    const client = new WindowsPC('windows-pc', 'PC-WIN');
    const observer = new LinuxPC('linux-pc', 'OBS');
    new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[1]);
    new Cable('c2').connect(observer.getPort('eth0')!, sw.getPorts()[2]);
    const seen = record(observer.getPort('eth0')!);
    await observer.executeCommand('ip link set eth0 up');
    await runPowershell(powershell(client), 'ipconfig /renew');

    expect(kinds(seen, 'in', 'DHCPDISCOVER', 'DHCPREQUEST').length).toBeGreaterThan(0);
    expect(kinds(seen, 'in', 'DHCPOFFER', 'DHCPACK')).toEqual([]);
  });
});

describe('the Windows broadcast flag toggle (Windows 7 and later)', () => {
  function offerOnlyWhen(flag: boolean): { channel: DhcpServerChannel; seen: boolean[] } {
    const seen: boolean[] = [];
    const channel: DhcpServerChannel = {
      serverIP: '10.5.0.1',
      processDiscover: (params) => {
        seen.push(params.broadcast);
        if (params.broadcast !== flag) return null;
        const pool = createDefaultPoolConfig('probe');
        return { type: 'OFFER', xid: params.xid, ip: '10.5.0.50', serverIdentifier: '10.5.0.1', pool } as unknown as ReturnType<DhcpServerChannel['processDiscover']>;
      },
      processRequestWithNak: () => null,
      processRequest: () => null,
      processDecline: () => undefined,
      processRelease: () => undefined,
    };
    return { channel, seen };
  }

  function clientWith(channel: DhcpServerChannel): DHCPClient {
    const client = new DHCPClient(() => '02:00:00:00:00:01', () => undefined, () => undefined);
    client.setBroadcastFlagToggling(false);
    client.setWireChannelFactory(() => channel);
    return client;
  }

  it('sends its DISCOVER with the flag clear first, then toggles it when nothing answers', () => {
    const { channel, seen } = offerOnlyWhen(true);
    clientWith(channel).requestLease('eth0');
    expect(seen).toEqual([false, true]);
  });

  it('keeps the flag that obtained an OFFER for the next acquisition', () => {
    const { channel, seen } = offerOnlyWhen(true);
    const client = clientWith(channel);
    client.requestLease('eth0');
    seen.length = 0;
    client.requestLease('eth0');
    expect(seen[0]).toBe(true);
  });

  it('goes back to the remembered flag when neither value is answered', () => {
    const { channel, seen } = offerOnlyWhen(true);
    const client = clientWith({ ...channel, processDiscover: (params) => { seen.push(params.broadcast); return null; } });
    client.requestLease('eth0');
    seen.length = 0;
    client.requestLease('eth0');
    expect(seen[0]).toBe(false);
  });

  it('a client with a fixed flag never toggles — WITNESS (dhclient)', () => {
    const { channel, seen } = offerOnlyWhen(true);
    const client = new DHCPClient(() => '02:00:00:00:00:01', () => undefined, () => undefined);
    client.setBroadcastFlag(false);
    client.setWireChannelFactory(() => channel);
    client.requestLease('eth0');
    expect(seen).toEqual([false]);
  });
});

describe('a Linux client whose INPUT policy is DROP', () => {
  it('drops a ping addressed to it — WITNESS that the policy bites', async () => {
    const { port, server } = await isc();
    const { client } = await linuxClient(port);
    await client.executeCommand('ip addr add 10.9.0.50/24 dev eth0');
    const before = await server.executeCommand('ping -c 1 -W 1 10.9.0.50');
    await client.executeCommand('sudo iptables -P INPUT DROP');
    const after = await server.executeCommand('ping -c 1 -W 1 10.9.0.50');

    expect(before).toContain(' 0% packet loss');
    expect(after).toContain('100% packet loss');
  });

  it('still obtains its lease: dhclient reads the reply before the IP filter', async () => {
    const { port, address } = await isc();
    const { client } = await linuxClient(port);
    await client.executeCommand('sudo iptables -P INPUT DROP');
    await client.executeCommand('dhclient eth0');

    expect(await inet(client)).toContain(`${address}/24`);
  });
});

describe('two Linux clients on a hub', () => {
  it('each keep the address offered to them, never the other one', async () => {
    const { port } = await isc();
    const hub = new Hub('HUB', 4);
    new Cable('up').connect(port, hub.getPorts()[0]);
    const first = new LinuxPC('linux-pc', 'PC1');
    const second = new LinuxPC('linux-pc', 'PC2');
    new Cable('c1').connect(first.getPort('eth0')!, hub.getPorts()[1]);
    new Cable('c2').connect(second.getPort('eth0')!, hub.getPorts()[2]);
    await first.executeCommand('ip link set eth0 up');
    await second.executeCommand('ip link set eth0 up');
    await first.executeCommand('dhclient eth0');
    await second.executeCommand('dhclient eth0');

    const one = await inet(first);
    const two = await inet(second);
    expect(one).toContain('10.9.0.100/24');
    expect(two).toContain('10.9.0.101/24');
  });
});

describe('a third machine on the same switch', () => {
  async function observed(setFlag: boolean): Promise<Seen[]> {
    const { port } = await isc();
    const sw = new GenericSwitch('switch-generic', 'SW');
    new Cable('up').connect(port, sw.getPorts()[0]);
    const client = new LinuxPC('linux-pc', 'PC');
    const observer = new LinuxPC('linux-pc', 'OBS');
    new Cable('c1').connect(client.getPort('eth0')!, sw.getPorts()[1]);
    new Cable('c2').connect(observer.getPort('eth0')!, sw.getPorts()[2]);
    client.getDHCPClient().setBroadcastFlag(setFlag);
    const seen = record(observer.getPort('eth0')!);
    await client.executeCommand('ip link set eth0 up');
    await observer.executeCommand('ip link set eth0 up');
    await client.executeCommand('dhclient eth0');
    return seen;
  }

  it('sees the broadcast requests of a client that leaves the flag clear, not the unicast replies', async () => {
    const seen = await observed(false);

    expect(kinds(seen, 'in', 'DHCPDISCOVER', 'DHCPREQUEST').length).toBe(2);
    expect(kinds(seen, 'in', 'DHCPOFFER', 'DHCPACK')).toEqual([]);
  });

  it('sees the replies as well when the client sets the flag — WITNESS that the observer works', async () => {
    const seen = await observed(true);

    expect(kinds(seen, 'in', 'DHCPOFFER', 'DHCPACK').map(entry => entry.kind)).toEqual(['DHCPOFFER', 'DHCPACK']);
  });
});
