/**
 * PRD-Windows-Server.md §5 P7 — DNS Server role core: `WindowsDnsServerRole`
 * hosts the real DNS engine (src/network/dns/) over genuine UDP/TCP port
 * 53 — zones, records, and clients resolving through the actual wire
 * protocol, reusing the same engine the Linux BIND9 service hosts (no
 * DNS logic reimplemented).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WindowsDnsServerRole } from '@/network/devices/windows/server/dns/WindowsDnsServerRole';
import type { EndHost } from '@/network/devices/EndHost';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { ARecordData, SrvRecordData } from '@/network/dns/wire/ResourceRecord';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function topology() {
  const server = new LinuxPC('linux-pc', 'DNSHOST');
  const client = new LinuxPC('linux-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.50.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.50.20'), mask);
  return { server: server as unknown as EndHost, client };
}

describe('WindowsDnsServerRole — zone/record admin surface', () => {
  it('creates a primary zone with a real SOA record', () => {
    const { server } = topology();
    const role = new WindowsDnsServerRole(server);
    const res = role.addPrimaryZone('lab.local');
    expect(res.ok).toBe(true);
    expect(role.getZone('lab.local')).not.toBeNull();
  });

  it('refuses to create a duplicate zone', () => {
    const { server } = topology();
    const role = new WindowsDnsServerRole(server);
    role.addPrimaryZone('lab.local');
    const res = role.addPrimaryZone('lab.local');
    expect(res.ok).toBe(false);
  });

  it('adds A/CNAME/MX/PTR/SRV records and lists them back', () => {
    const { server } = topology();
    const role = new WindowsDnsServerRole(server);
    role.addPrimaryZone('lab.local');
    expect(role.addARecord('lab.local', 'ws01', '192.168.50.30').ok).toBe(true);
    expect(role.addCnameRecord('lab.local', 'www', 'ws01.lab.local').ok).toBe(true);
    expect(role.addMxRecord('lab.local', '@', 10, 'mail.lab.local').ok).toBe(true);
    expect(role.addSrvRecord('lab.local', '_ldap._tcp.dc._msdcs', { priority: 0, weight: 100, port: 389, target: 'dc1.lab.local' }).ok).toBe(true);

    const records = role.getRecords('lab.local')!;
    expect(records.some(r => r.name === 'ws01.lab.local' && r.type === 'A')).toBe(true);
    expect(records.some(r => r.name === 'www.lab.local' && r.type === 'CNAME')).toBe(true);
    expect(records.some(r => r.type === 'SRV' && r.text.includes('389'))).toBe(true);
  });

  it('adds a PTR record in a reverse-lookup zone', () => {
    const { server } = topology();
    const role = new WindowsDnsServerRole(server);
    role.addPrimaryZone('50.168.192.in-addr.arpa');
    const res = role.addPtrRecord('50.168.192.in-addr.arpa', '30', 'ws01.lab.local');
    expect(res.ok).toBe(true);
    const records = role.getRecords('50.168.192.in-addr.arpa')!;
    expect(records.some(r => r.type === 'PTR' && r.text === 'ws01.lab.local')).toBe(true);
  });

  it('bumps the zone SOA serial on every record change', () => {
    const { server } = topology();
    const role = new WindowsDnsServerRole(server);
    role.addPrimaryZone('lab.local');
    const before = role.getRecords('lab.local')!.find(r => r.type === 'SOA')!.text;
    role.addARecord('lab.local', 'ws01', '192.168.50.30');
    const after = role.getRecords('lab.local')!.find(r => r.type === 'SOA')!.text;
    expect(after).not.toBe(before);
  });

  it('removes a record', () => {
    const { server } = topology();
    const role = new WindowsDnsServerRole(server);
    role.addPrimaryZone('lab.local');
    role.addARecord('lab.local', 'ws01', '192.168.50.30');
    const res = role.removeRecord('lab.local', 'ws01', 'A');
    expect(res.ok).toBe(true);
    expect(role.getRecords('lab.local')!.some(r => r.type === 'A')).toBe(false);
  });

  it('lists zones', () => {
    const { server } = topology();
    const role = new WindowsDnsServerRole(server);
    role.addPrimaryZone('lab.local');
    role.addPrimaryZone('other.local');
    expect(role.listZones().map(z => z.name).sort()).toEqual(['lab.local', 'other.local']);
  });
});

describe('WindowsDnsServerRole — real UDP/TCP 53 answering', () => {
  it('answers an A query over real UDP from another device', async () => {
    const { server, client } = topology();
    const role = new WindowsDnsServerRole(server);
    role.start();
    role.addPrimaryZone('lab.local');
    role.addARecord('lab.local', 'ws01', '192.168.50.30');

    const response = await client.queryDnsServer(new IPAddress('192.168.50.10'), 'ws01.lab.local', 'A');
    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((response!.answers[0]?.data as ARecordData).address.toString()).toBe('192.168.50.30');
  });

  it('answers a SRV query (DC locator record)', async () => {
    const { server, client } = topology();
    const role = new WindowsDnsServerRole(server);
    role.start();
    role.addPrimaryZone('lab.local');
    role.addSrvRecord('lab.local', '_ldap._tcp.dc._msdcs', { priority: 0, weight: 100, port: 389, target: 'dc1.lab.local' });

    const response = await client.queryDnsServer(new IPAddress('192.168.50.10'), '_ldap._tcp.dc._msdcs.lab.local', 'SRV');
    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    const srv = response!.answers[0]?.data as SrvRecordData;
    expect(srv.port).toBe(389);
    expect(srv.target).toBe('dc1.lab.local');
  });

  it('answers NXDOMAIN for an unknown name inside a hosted zone', async () => {
    const { server, client } = topology();
    const role = new WindowsDnsServerRole(server);
    role.start();
    role.addPrimaryZone('lab.local');

    const response = await client.queryDnsServer(new IPAddress('192.168.50.10'), 'ghost.lab.local', 'A');
    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('answers REFUSED for a name outside any hosted zone when no forwarder is configured', async () => {
    const { server, client } = topology();
    const role = new WindowsDnsServerRole(server);
    role.start();
    role.addPrimaryZone('lab.local');

    const response = await client.queryDnsServer(new IPAddress('192.168.50.10'), 'example.com', 'A');
    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.REFUSED);
  });

  it('stops answering once stop() is called', async () => {
    const { server, client } = topology();
    const role = new WindowsDnsServerRole(server);
    role.start();
    role.addPrimaryZone('lab.local');
    role.addARecord('lab.local', 'ws01', '192.168.50.30');
    role.stop();

    const response = await client.queryDnsServer(new IPAddress('192.168.50.10'), 'ws01.lab.local', 'A', 300);
    expect(response).toBeNull();
  });
});

describe('WindowsDnsServerRole — forwarders (Set-DnsServerForwarder)', () => {
  it('forwards a query for a name outside any hosted zone to the configured forwarder', async () => {
    const forwarder = new LinuxPC('linux-pc', 'FWD1');
    const server = new LinuxPC('linux-pc', 'DNSHOST');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c1').connect(forwarder.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
    new Cable('c3').connect(client.getPorts()[0], sw.getPorts()[2]);
    const mask = new SubnetMask('255.255.255.0');
    forwarder.getPorts()[0].configureIP(new IPAddress('192.168.51.5'), mask);
    server.getPorts()[0].configureIP(new IPAddress('192.168.51.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.51.20'), mask);

    const upstreamRole = new WindowsDnsServerRole(forwarder as unknown as EndHost);
    upstreamRole.start();
    upstreamRole.addPrimaryZone('example.com');
    upstreamRole.addARecord('example.com', 'www', '203.0.113.5');

    const role = new WindowsDnsServerRole(server as unknown as EndHost);
    role.start();
    role.addPrimaryZone('lab.local');
    role.setForwarders(['192.168.51.5']);

    const response = await client.queryDnsServer(new IPAddress('192.168.51.10'), 'www.example.com', 'A', 3000);
    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((response!.answers[0]?.data as ARecordData).address.toString()).toBe('203.0.113.5');
  });
});
