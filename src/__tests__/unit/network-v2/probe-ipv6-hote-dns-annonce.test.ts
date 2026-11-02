/**
 * The RDNSS (RFC 8106 §5.1) and DNSSL (§5.2) options of a Router Advertisement on a Linux host. The kernel only forwards them to user space (RTM_NEWNDUSEROPT); on Ubuntu the user-space
 * consumer is systemd-networkd or NetworkManager, which add the servers and search domains of the link for the option's lifetime and drop them when it runs out (a lifetime of 0 withdraws them
 * at once, 0xffffffff never expires). The simulator applies that to /etc/resolv.conf, the file every resolver in it reads. A link-local server is written with its zone (`fe80::1%eth0`).
 * Measured before the change: the options were never read, /etc/resolv.conf stayed empty. The DHCPv6 path appended a SECOND `search` line (glibc keeps the last one only) where one line must carry
 * every domain; ResolvConfEdit now merges both sources into one.
 * Discriminated with git stash on src/network: 4 of 6 cases fall (server added, domains on one search line, expiry, withdrawal by lifetime 0). The 2 that pass either way are the WITNESS (a router that advertises no DNS option leaves the file untouched)
 * and the ResolvConfEdit unit case (the new helper file is untracked, so the stash leaves it in place).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock } from '../../support/ntpTime';
import { radvdLab } from '../../support/radvdLab';
import { addNameserver, addSearchDomain, removeNameserver, removeSearchDomain } from '@/network/devices/linux/ResolvConfEdit';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  EquipmentRegistry.getInstance().clear();
});

const config = (extra: string) =>
  `interface eth0 {\n  AdvSendAdvert on;\n  MinRtrAdvInterval 600;\n  MaxRtrAdvInterval 1800;\n  ${extra}\n  prefix 2001:db8:77::/64 { };\n};`;

describe('RDNSS and DNSSL options of a Router Advertisement', () => {
  it('WITNESS: without the options /etc/resolv.conf is untouched', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config(''));
    await onRouter('systemctl start radvd');
    expect(await onHost('cat /etc/resolv.conf')).not.toContain('nameserver');
  });

  it('a server is added for the lifetime of the option', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('RDNSS 2001:db8::53 { AdvRDNSSLifetime 600; };'));
    await onRouter('systemctl start radvd');
    expect(await onHost('cat /etc/resolv.conf')).toContain('nameserver 2001:db8::53');
  });

  it('the search domains share one search line', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('DNSSL example.com lab.local { AdvDNSSLLifetime 600; };'));
    await onRouter('systemctl start radvd');
    const file = await onHost('cat /etc/resolv.conf');
    expect(file.split('\n').filter((line) => line.startsWith('search '))).toEqual(['search example.com lab.local']);
  });

  it('the entry disappears when its lifetime runs out', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('RDNSS 2001:db8::53 { AdvRDNSSLifetime 60; };\n  DNSSL example.com { AdvDNSSLLifetime 60; };'));
    await onRouter('systemctl start radvd');
    expect(await onHost('cat /etc/resolv.conf')).toContain('nameserver 2001:db8::53');
    await onRouter('systemctl stop radvd');
    await clock.advance(61_000);
    const file = await onHost('cat /etc/resolv.conf');
    expect(file).not.toContain('2001:db8::53');
    expect(file).not.toContain('example.com');
  });

  it('a lifetime of 0 withdraws the server at once', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('RDNSS 2001:db8::53 { AdvRDNSSLifetime 600; FlushRDNSS on; };'));
    await onRouter('systemctl start radvd');
    expect(await onHost('cat /etc/resolv.conf')).toContain('nameserver 2001:db8::53');
    await onRouter('systemctl stop radvd');
    expect(await onHost('cat /etc/resolv.conf')).not.toContain('2001:db8::53');
  });

  it('ResolvConfEdit merges and removes without duplicating', () => {
    let text = addSearchDomain('', 'a.example');
    text = addSearchDomain(text, 'b.example');
    text = addSearchDomain(text, 'a.example');
    text = addNameserver(text, '10.0.0.1');
    text = addNameserver(text, '10.0.0.1');
    expect(text).toBe('search a.example b.example\nnameserver 10.0.0.1\n');
    text = removeSearchDomain(removeNameserver(text, '10.0.0.1'), 'a.example');
    expect(text).toBe('search b.example\n');
    expect(removeSearchDomain(text, 'b.example')).toBe('');
  });
});
