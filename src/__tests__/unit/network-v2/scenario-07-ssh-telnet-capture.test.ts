import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Topology {
  client: LinuxPC;
  server: LinuxServer;
  capture: LinuxPC;
  sw: CiscoSwitch;
}

function buildTopology(): Topology {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('SERVER');
  const capture = new LinuxPC('linux-pc', 'SNIFFER');

  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  capture.getPort('eth0')!.configureIP(new IPAddress('10.0.0.99'), new SubnetMask('255.255.255.0'));

  new Cable('cab-client').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('cab-server').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('cab-sniffer').connect(capture.getPort('eth0')!, sw.getPort('FastEthernet0/8')!);

  return { client, server, capture, sw };
}

function captureLog(host: LinuxPC | LinuxServer) {
  return (host as unknown as { executor: { captureLog: { all: () => readonly { srcIp: string; dstIp: string; srcPort: number; dstPort: number; payload?: Uint8Array }[] } } }).executor.captureLog;
}

function asAscii(bytes?: Uint8Array): string {
  if (!bytes) return '';
  let out = '';
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += '.';
  }
  return out;
}

function flatPayload(host: LinuxPC | LinuxServer, port?: number): string {
  return captureLog(host).all()
    .filter(p => port == null || p.srcPort === port || p.dstPort === port)
    .map(p => asAscii(p.payload))
    .join('\n');
}

describe('Scenario 7 — Capture et analyse de paquets sur un lien SSH', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('SSH session: la capture expose la négociation mais aucun mot de passe ni commande en clair', async () => {
    const { client, server, sw, capture } = buildTopology();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 1 source interface FastEthernet0/1');
    await sw.executeCommand('monitor session 1 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    await server.executeCommand('useradd alice');
    await server.executeCommand('echo "alice:ssh-secret-PW!" | chpasswd');
    await server.executeCommand('systemctl start ssh');

    await capture.executeCommand('tcpdump -i eth0 -w /tmp/ssh.pcap &');

    await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.20 "cat /etc/shadow"', 'ssh-secret-PW!\n');

    const tcpdumpOut = await capture.executeCommand('tcpdump -r /tmp/ssh.pcap -A');
    expect(tcpdumpOut).toMatch(/SSH-2\.0/);
    expect(tcpdumpOut).not.toContain('ssh-secret-PW!');
    expect(tcpdumpOut).not.toContain('cat /etc/shadow');

    const sniffer = flatPayload(capture);
    expect(sniffer).toMatch(/SSH-2\.0/);
    expect(sniffer).not.toContain('ssh-secret-PW!');
    expect(sniffer).not.toContain('cat /etc/shadow');
  });

  it('Telnet session: la capture expose le mot de passe et les commandes en clair', async () => {
    const { client, server, sw, capture } = buildTopology();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 1 source interface FastEthernet0/1');
    await sw.executeCommand('monitor session 1 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    await server.executeCommand('useradd bob');
    await server.executeCommand('echo "bob:telnet-cleartext" | chpasswd');
    await server.executeCommand('systemctl start telnet');

    await capture.executeCommand('tcpdump -i eth0 -w /tmp/telnet.pcap &');

    await client.executeCommand('telnet 10.0.0.20', 'bob\ntelnet-cleartext\nls /etc/shadow\nexit\n');

    const tcpdumpOut = await capture.executeCommand('tcpdump -r /tmp/telnet.pcap -A');
    expect(tcpdumpOut).toContain('telnet-cleartext');
    expect(tcpdumpOut).toContain('ls /etc/shadow');

    const sniffer = flatPayload(capture, 23);
    expect(sniffer).toContain('telnet-cleartext');
    expect(sniffer).toContain('ls /etc/shadow');
  });

  it('Comparaison: aucune donnée applicative lisible côté SSH, conversation entière côté Telnet', async () => {
    const { client, server, sw, capture } = buildTopology();
    const swPorts = sw.getPortNames();

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 1 source interface FastEthernet0/1 both');
    await sw.executeCommand('monitor session 1 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    await server.executeCommand('useradd carol');
    await server.executeCommand('echo "carol:carolsecret123" | chpasswd');
    await server.executeCommand('systemctl start ssh');

    await capture.executeCommand('tcpdump -i eth0 -w /tmp/ssh2.pcap &');
    await client.executeCommand('ssh -o StrictHostKeyChecking=no carol@10.0.0.20 "uname -a"', 'carolsecret123\n');
    const sshPayloads = captureLog(capture).all().filter(p => p.srcPort === 22 || p.dstPort === 22);
    captureLog(capture).clear();

    await server.executeCommand('systemctl stop ssh');
    await server.executeCommand('systemctl start telnet');
    await capture.executeCommand('tcpdump -i eth0 -w /tmp/telnet2.pcap &');
    await client.executeCommand('telnet 10.0.0.20', 'carol\ncarolsecret123\nuname -a\nexit\n');
    const telnetPayloads = captureLog(capture).all().filter(p => p.srcPort === 23 || p.dstPort === 23);

    const sshAscii = sshPayloads.map(p => asAscii(p.payload)).join('');
    const telnetAscii = telnetPayloads.map(p => asAscii(p.payload)).join('');

    expect(sshAscii).not.toContain('carolsecret123');
    expect(sshAscii).not.toContain('uname -a');

    expect(telnetAscii).toContain('carolsecret123');
    expect(telnetAscii).toContain('uname -a');
  });
});
