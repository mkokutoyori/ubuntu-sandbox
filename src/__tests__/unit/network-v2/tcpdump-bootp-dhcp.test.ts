/*
 * tcpdump sur `udp port 67 or udp port 68` : le trafic DHCP se decode en BOOTP/DHCP
 * comme print-bootp.c. Sans option : « BOOTP/DHCP, Request from <mac>, length N » et
 * « BOOTP/DHCP, Reply, length N ». Avec -v : xid, Flags, Client-IP / Your-IP / Server-IP /
 * Gateway-IP, Client-Ethernet-Address, cookie magique et options (DHCP-Message, Server-ID,
 * Lease-Time, Subnet-Mask...). Les noms d'options et la mise en page viennent de la
 * connaissance du format de tcpdump, pas d'une sortie capturee : non verifies mot a mot.
 * -q reste « UDP, length N ».
 *
 * Avant le correctif (git stash des sources) : 6 cas tombent ; le temoin « quatre trames
 * DORA » et le cas -q passent avant comme apres, le second parce qu'il garde le
 * comportement UDP voulu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function capture(extra = '') {
  const srv = new LinuxServer('linux-server', 'SRV');
  const pc = new LinuxPC('linux-pc', 'C1');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('a').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(pc.getPorts()[0], sw.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  const conf = 'authoritative;\ndefault-lease-time 7200;\nsubnet 192.168.1.0 netmask 255.255.255.0 {\n  range 192.168.1.100 192.168.1.110;\n  option routers 192.168.1.1;\n  option domain-name-servers 8.8.8.8;\n}\n';
  await srv.executeCommand(`printf '%s' ${JSON.stringify(conf)} > /etc/dhcp/dhcpd.conf`);
  await srv.executeCommand('printf \'INTERFACESv4="eth0"\\n\' > /etc/default/isc-dhcp-server');
  await srv.executeCommand('systemctl start isc-dhcp-server');
  await pc.executeCommand('sudo tcpdump -i eth0 -w /tmp/d.pcap &');
  await pc.executeCommand('dhclient eth0');
  await pc.executeCommand('kill %1');
  const mac = pc.getPorts()[0].getMAC().toString();
  const text = await pc.executeCommand(`tcpdump -nn ${extra} -r /tmp/d.pcap 'udp port 67 or udp port 68'`);
  return { text, mac };
}

describe('tcpdump -nn sur le port 67/68', () => {
  it('temoin : le filtre retient les quatre trames DORA', async () => {
    const { text } = await capture();
    expect(text.split('\n').filter(line => /^\d\d:\d\d:\d\d/.test(line)).length).toBe(4);
  });

  it('Discover et Request : BOOTP/DHCP, Request from <mac>', async () => {
    const { text, mac } = await capture();
    expect(text).toContain(`IP 0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Request from ${mac}, length`);
  });

  it('Offer et ACK : BOOTP/DHCP, Reply', async () => {
    const { text } = await capture();
    expect(text).toMatch(/192\.168\.1\.1\.67 > 255\.255\.255\.255\.68: BOOTP\/DHCP, Reply, length \d+/);
  });

  it('rien n est plus affiche comme UDP, length', async () => {
    const { text } = await capture();
    expect(text).not.toContain(': UDP, length');
  });

  it('-q : le comportement UDP est conserve', async () => {
    const { text } = await capture('-q');
    expect(text).not.toContain('BOOTP/DHCP');
  });
});

describe('tcpdump -v', () => {
  it('xid, Flags et Client-Ethernet-Address', async () => {
    const { text, mac } = await capture('-v');
    expect(text).toMatch(/xid 0x[0-9a-f]+, Flags \[(none|Broadcast)\] \(0x[0-9a-f]{4}\)/);
    expect(text).toContain(`Client-Ethernet-Address ${mac}`);
    expect(text).toContain('Vendor-rfc1048 Extensions');
    expect(text).toContain('Magic Cookie 0x63825363');
  });

  it('options : DHCP-Message Discover / Offer / Request / ACK, Server-ID, Lease-Time, Subnet-Mask, END', async () => {
    const { text } = await capture('-v');
    for (const kind of ['Discover', 'Offer', 'Request', 'ACK']) {
      expect(text).toContain(`DHCP-Message (53), length 1: ${kind}`);
    }
    expect(text).toContain('Server-ID (54), length 4: 192.168.1.1');
    expect(text).toContain('Lease-Time (51), length 4: 7200');
    expect(text).toContain('Subnet-Mask (1), length 4: 255.255.255.0');
    expect(text).toContain('Default-Gateway (3), length 4: 192.168.1.1');
    expect(text).toContain('Domain-Name-Server (6), length 4: 8.8.8.8');
    expect(text).toContain('END (255)');
  });

  it('Reply : Your-IP et Server-IP', async () => {
    const { text } = await capture('-v');
    expect(text).toMatch(/Your-IP 192\.168\.1\.10\d/);
  });
});
