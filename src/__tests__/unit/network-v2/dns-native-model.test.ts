import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { makeARecord, makeCnameRecord } from '@/network/dns/wire/ResourceRecord';
import type { ARecordData, ResourceRecord } from '@/network/dns/wire/ResourceRecord';
import { WindowsDnsCache, renderDisplayDns } from '@/network/devices/windows/WinDnsCache';

const SERVER_IP = '10.0.1.10';

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  srv.dnsService.addRecord({ name: 'webserver.lan', type: 'A', value: '10.0.1.88', ttl: 3600 });
  srv.dnsService.start();
  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('EndHost stub resolver returns the engine-native message model', () => {
  it('async lookup yields a DnsMessage with numeric rcode and typed RDATA', async () => {
    const { pc } = buildTopology();

    const reply = await pc.queryDnsServer(new IPAddress(SERVER_IP), 'webserver.lan', 'A', 500);

    expect(reply).not.toBeNull();
    expect(reply!.flags.qr).toBe(true);
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply!.answers).toHaveLength(1);
    const answer = reply!.answers[0];
    expect(answer.data.type).toBe(RRType.A);
    expect((answer.data as ARecordData).address).toBeInstanceOf(IPAddress);
    expect((answer.data as ARecordData).address.toString()).toBe('10.0.1.88');
  });

  it('sync lookup (NSS contract) yields the same native model', () => {
    const { pc } = buildTopology();

    const reply = pc.queryDnsServerSync(new IPAddress(SERVER_IP), 'webserver.lan', 'A');

    expect(reply).not.toBeNull();
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply!.answers[0].data.type).toBe(RRType.A);
  });

  it('reports NXDOMAIN through the numeric header rcode', async () => {
    const { pc } = buildTopology();

    const reply = await pc.queryDnsServer(new IPAddress(SERVER_IP), 'ghost.lan', 'A', 500);

    expect(reply).not.toBeNull();
    expect(reply!.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(reply!.answers).toHaveLength(0);
  });
});

describe('NSS dns source consumes the native model', () => {
  it('getent hosts resolves through the wire', async () => {
    const { pc } = buildTopology();
    await pc.executeCommand(`sudo sh -c 'echo "nameserver ${SERVER_IP}" > /etc/resolv.conf'`);

    const out = await pc.executeCommand('getent hosts webserver.lan');

    expect(out).toContain('10.0.1.88');
    expect(out).toContain('webserver.lan');
  }, 15000);
});

describe('Windows DNS cache stores engine-native records', () => {
  it('accepts ResourceRecords and renders them in ipconfig /displaydns form', () => {
    const cache = new WindowsDnsCache();
    const records: ResourceRecord[] = [
      makeARecord('app.corp.local', 300, '192.0.2.50'),
      makeCnameRecord('www.corp.local', 300, 'app.corp.local'),
    ];

    cache.store('app.corp.local', records);

    expect(cache.size()).toBe(2);
    const rendered = renderDisplayDns(cache);
    expect(rendered).toContain('app.corp.local');
    expect(rendered).toContain('192.0.2.50');
    expect(rendered).toContain('Record Type . . . . . : 1');
  });

  it('feeds the cache from a live nslookup on a Windows host', async () => {
    const { srv } = buildTopology();
    const win = new WindowsPC('windows-pc', 'WIN1');
    win.configureInterface('eth1', new IPAddress('10.0.2.30'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth1', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));
    new Cable('c-win').connect(win.getPort('eth1')!, srv.getPort('eth1')!);

    const out = await win.executeCommand('nslookup webserver.lan 10.0.2.10');

    expect(out).toContain('10.0.1.88');
  }, 15000);
});
