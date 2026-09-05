import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { dnsCacheRowsOf, renderDisplayDns } from '@/network/devices/windows/dnsClientCache';
import { makeARecord, makeAaaaRecord } from '@/network/dns/wire/ResourceRecord';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('le cache DNS du client Windows est celui du projet', () => {
  it('starts empty', () => {
    const c = new DnsCache();
    expect(c.size()).toBe(0);
  });

  it('store() registers one entry per answer record', () => {
    const c = new DnsCache();
    c.storePositive([
      makeARecord('example.com', 3600, '93.184.216.34'),
      makeAaaaRecord('example.com', 3600, '2606:2800:220:1::1'),
    ], 'example.com');
    expect(c.size()).toBe(2);
  });

  it('store() de-dups on (name, type) — last write wins', () => {
    const c = new DnsCache();
    c.storePositive([makeARecord('example.com', 60, '1.1.1.1')], 'example.com');
    c.storePositive([makeARecord('example.com', 60, '2.2.2.2')], 'example.com');
    const entries = c.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toBe('2.2.2.2');
  });

  it('flush() drops every entry', () => {
    const c = new DnsCache();
    c.storePositive([
      makeARecord('example.com', 60, '1.1.1.1'),
      makeAaaaRecord('example.com', 60, '::1'),
    ], 'example.com');
    expect(c.size()).toBe(2);
    c.flush();
    expect(c.size()).toBe(0);
  });

  it('honours TTL — entries past their lifetime are evicted on read', () => {
    let now = 1_700_000_000_000;
    const c = new DnsCache(() => now);
    c.storePositive([makeARecord('example.com', 30, '1.1.1.1')], 'example.com');
    expect(c.size()).toBe(1);
    now += 29_000;
    expect(c.size()).toBe(1);
    now += 1_001;
    expect(c.size()).toBe(0);
  });

  it('case-insensitive name keying', () => {
    const c = new DnsCache();
    c.storePositive([makeARecord('EXAMPLE.com', 60, '1.1.1.1')], 'EXAMPLE.com');
    c.storePositive([makeARecord('example.COM', 60, '2.2.2.2')], 'example.COM');
    expect(c.entries()).toHaveLength(1);
    expect(c.entries()[0].data).toBe('2.2.2.2');
  });
});

describe('renderDisplayDns — ipconfig /displaydns formatting', () => {
  it('reproduces the empty-cache form verbatim', () => {
    const c = new DnsCache();
    const out = renderDisplayDns(dnsCacheRowsOf(c.entries()));
    expect(out).toContain('Windows IP Configuration');
    expect(out).toContain('(no entries)');
  });

  it('renders one paragraph per record with the real Windows fields', () => {
    let now = 1_700_000_000_000;
    const c = new DnsCache(() => now);
    c.storePositive([makeARecord('example.com', 3600, '93.184.216.34')], 'example.com');
    now += 10_000;
    const out = renderDisplayDns(dnsCacheRowsOf(c.entries()));
    expect(out).toContain('Record Name . . . . . : example.com');
    expect(out).toMatch(/Record Type \. \. \. \. \. : 1/);
    expect(out).toMatch(/Time To Live  \. \. \. \. : 3590/);
    expect(out).toContain('A (Host) Record  . . . : 93.184.216.34');
  });
});

describe('Integration — WindowsPC.resolveHostname populates the cache', () => {
  function setupLab() {
    const win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const dns = new LinuxServer('linux-server', 'dns1', 0, 0);
    new Cable('c1').connect(win.getPort('eth0')!, dns.getPort('eth0')!);
    win.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
    dns.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    return { win, dns };
  }

  it('populates the cache on a successful DNS answer', async () => {
    const { win, dns } = setupLab();
    dns.dnsService.start();
    dns.dnsService.addRecord({ name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 3600 });
    win['dnsConfig'] = new Map([['eth0', { servers: ['10.0.0.1'], mode: 'static' }]]);

    expect(win.dnsCache.size()).toBe(0);
    const ip = await win.resolveHostname('example.com');
    expect(ip?.toString()).toBe('93.184.216.34');
    expect(win.dnsCache.size()).toBeGreaterThanOrEqual(1);
    const out = renderDisplayDns(dnsCacheRowsOf(win.dnsCache.entries()));
    expect(out).toContain('example.com');
    expect(out).toContain('93.184.216.34');
  });

  it('ipconfig /flushdns clears the cache through the real command path', async () => {
    const { win, dns } = setupLab();
    dns.dnsService.start();
    dns.dnsService.addRecord({ name: 'example.com', type: 'A', value: '1.2.3.4', ttl: 3600 });
    win['dnsConfig'] = new Map([['eth0', { servers: ['10.0.0.1'], mode: 'static' }]]);
    await win.resolveHostname('example.com');
    expect(win.dnsCache.size()).toBeGreaterThan(0);

    const out = await win.executeCommand('ipconfig /flushdns');
    expect(out).toContain('Successfully flushed the DNS Resolver Cache.');
    expect(win.dnsCache.size()).toBe(0);
  });

  it('ipconfig /displaydns surfaces a freshly-cached answer', async () => {
    const { win, dns } = setupLab();
    dns.dnsService.start();
    dns.dnsService.addRecord({ name: 'example.com', type: 'A', value: '5.6.7.8', ttl: 3600 });
    win['dnsConfig'] = new Map([['eth0', { servers: ['10.0.0.1'], mode: 'static' }]]);
    await win.resolveHostname('example.com');

    const out = await win.executeCommand('ipconfig /displaydns');
    expect(out).toContain('example.com');
    expect(out).toContain('5.6.7.8');
    expect(out).not.toContain('(no entries)');
  });
});
