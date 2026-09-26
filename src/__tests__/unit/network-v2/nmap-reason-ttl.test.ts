/*
 * Under --reason, nmap writes after each port's reason the TTL of the
 * reply that decided it, and "from <address>" when that reply did not come
 * from the target. Read in nmap at commit 3be01efb1 (7.94): output.cc:747
 * ("%s ttl %d" when reason.ttl is non-zero), portreasons.cc:416
 * port_reason_str ("%s from %s" when reason.ip_addr is set),
 * scan_engine_raw.cc:2136 (reason_sip is the reply's source only when it
 * is not the target) and :2153 (setStateReason with hdr.ttl, the IP header
 * of the reply, ICMP included), scan_engine_raw.cc:841 (a ping reply sets
 * the host's reason.ttl), output.cc:703 (reason_ttl and reason_ip in XML).
 * A connect() scan never sees a reply header, so its reasons carry no TTL.
 *
 * Measured before: `syn-ack`, `reset`, `admin-prohibited` and
 * `port-unreach` without TTL, a router's ICMP without its address, the -PS
 * host line without TTL, and reason_ttl="0" written as a constant in XML.
 *
 * DISCRIMINATION (git stash of src/network and the two nmap tests whose
 * probe fakes follow the new udpState shape): 5 of the 6 cases fall before
 * the change. The one that passes on both trees is the witness: a connect()
 * scan prints its reasons without TTL.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function segment(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await srv.executeCommand('iptables -A INPUT -p tcp --dport 23 -j REJECT --reject-with icmp-admin-prohibited');
  return { pc, srv };
}

async function routed(): Promise<LinuxPC> {
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const gw = new LinuxPC('linux-pc', 'GW');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  new Cable('a').connect(pc1.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('b').connect(gw.getPort('eth1')!, pc2.getPort('eth0')!);
  pc1.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc1.setDefaultGateway(new IPAddress('192.168.1.1'));
  gw.configureInterface('eth0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  gw.configureInterface('eth1', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  await gw.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');
  pc2.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  pc2.setDefaultGateway(new IPAddress('10.0.0.1'));
  await gw.executeCommand('sudo iptables -A FORWARD -p tcp --dport 23 -j REJECT --reject-with icmp-admin-prohibited');
  return pc1;
}

describe('a raw scan names the TTL of every reply', () => {
  it('SYN scan: syn-ack, reset and the target\'s own ICMP, each with ttl 64', async () => {
    const { pc } = await segment();
    const out = await pc.executeCommand('sudo nmap --reason -p 22,23,25 10.0.0.2');
    expect(out).toContain('22/tcp open     ssh     syn-ack ttl 64\n'
      + '23/tcp filtered telnet  admin-prohibited ttl 64\n'
      + '25/tcp closed   smtp    reset ttl 64\n');
  });

  it('UDP scan: port-unreach ttl 64', async () => {
    const { pc } = await segment();
    expect(await pc.executeCommand('sudo nmap -sU --reason -p 53 10.0.0.2'))
      .toContain('53/udp closed domain  port-unreach ttl 64\n');
  });

  it('a TCP ping reply puts its TTL on the host line', async () => {
    const { pc } = await segment();
    expect(await pc.executeCommand('sudo nmap -sn -PS22 --disable-arp-ping --reason 10.0.0.2'))
      .toMatch(/\nHost is up, received syn-ack ttl 64 \(\d\.\d+s latency\)\.\n/);
  });

  it('witness: a connect() scan has no reply header, hence no TTL', async () => {
    const { pc } = await segment();
    expect(await pc.executeCommand('nmap --reason -p 22,25 10.0.0.2'))
      .toContain('22/tcp open   ssh     syn-ack\n25/tcp closed smtp    conn-refused\n');
  });
});

describe('an ICMP from a router names the router', () => {
  it('admin-prohibited from the gateway, and one hop less on what crossed it', async () => {
    const pc1 = await routed();
    expect(await pc1.executeCommand('sudo nmap -Pn --reason -p 22,23 10.0.0.2'))
      .toContain('22/tcp open     ssh     syn-ack ttl 63\n'
        + '23/tcp filtered telnet  admin-prohibited from 192.168.1.1 ttl 64\n');
  });

  it('XML carries reason_ttl and reason_ip', async () => {
    const pc1 = await routed();
    await pc1.executeCommand('sudo nmap -Pn -p 22,23 -oX /tmp/r.xml 10.0.0.2');
    const xml = await pc1.executeCommand('cat /tmp/r.xml');
    expect(xml).toContain('<state state="open" reason="syn-ack" reason_ttl="63"/>');
    expect(xml).toContain('<state state="filtered" reason="admin-prohibited" reason_ttl="64" reason_ip="192.168.1.1"/>');
  });
});
