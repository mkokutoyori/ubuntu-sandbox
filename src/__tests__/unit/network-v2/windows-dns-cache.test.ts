import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsDnsCache, renderDisplayDns } from '@/network/devices/windows/WinDnsCache';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('WindowsDnsCache — pure data structure', () => {
  it('starts empty', () => {
    const c = new WindowsDnsCache();
    expect(c.size()).toBe(0);
  });

  it('store() registers one entry per answer record', () => {
    const c = new WindowsDnsCache();
    c.store('example.com', [
      { name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 3600 },
      { name: 'example.com', type: 'AAAA', value: '2606:2800:220:1::1', ttl: 3600 },
    ]);
    expect(c.size()).toBe(2);
  });

  it('store() de-dups on (name, type) — last write wins', () => {
    const c = new WindowsDnsCache();
    c.store('example.com', [{ name: 'example.com', type: 'A', value: '1.1.1.1', ttl: 60 }]);
    c.store('example.com', [{ name: 'example.com', type: 'A', value: '2.2.2.2', ttl: 60 }]);
    const entries = c.activeEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('2.2.2.2');
  });

  it('flush() drops every entry', () => {
    const c = new WindowsDnsCache();
    c.store('example.com', [
      { name: 'example.com', type: 'A', value: '1.1.1.1', ttl: 60 },
      { name: 'example.com', type: 'AAAA', value: '::1', ttl: 60 },
    ]);
    expect(c.size()).toBe(2);
    c.flush();
    expect(c.size()).toBe(0);
  });

  it('honours TTL — entries past their lifetime are evicted on read', () => {
    const c = new WindowsDnsCache();
    let now = 1_700_000_000_000;
    c.now = () => now;
    c.store('example.com', [{ name: 'example.com', type: 'A', value: '1.1.1.1', ttl: 30 }]);
    expect(c.size()).toBe(1);
    now += 29_000;
    expect(c.size()).toBe(1);
    now += 1_001;
    expect(c.size()).toBe(0);
  });

  it('case-insensitive name keying', () => {
    const c = new WindowsDnsCache();
    c.store('EXAMPLE.com', [{ name: 'EXAMPLE.com', type: 'A', value: '1.1.1.1', ttl: 60 }]);
    c.store('example.COM', [{ name: 'example.COM', type: 'A', value: '2.2.2.2', ttl: 60 }]);
    expect(c.activeEntries()).toHaveLength(1);
    expect(c.activeEntries()[0].value).toBe('2.2.2.2');
  });
});

describe('renderDisplayDns — ipconfig /displaydns formatting', () => {
  it('reproduces the empty-cache form verbatim', () => {
    const c = new WindowsDnsCache();
    const out = renderDisplayDns(c);
    expect(out).toContain('Windows IP Configuration');
    expect(out).toContain('(no entries)');
  });

  it('renders one paragraph per record with the real Windows fields', () => {
    const c = new WindowsDnsCache();
    let now = 1_700_000_000_000;
    c.now = () => now;
    c.store('example.com', [
      { name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 3600 },
    ]);
    now += 10_000; // 10s elapsed since insert
    const out = renderDisplayDns(c);
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
    const out = renderDisplayDns(win.dnsCache);
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
