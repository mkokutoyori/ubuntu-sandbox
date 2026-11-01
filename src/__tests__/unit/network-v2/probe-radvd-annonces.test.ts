/**
 * Le demon `radvd` d'un routeur Linux. Mesure de depart : `grep -ri radvd src/` ne rendait rien ; un LinuxServer a deux cartes qui transfere l'IPv6 (`probe-linux-transfert-ipv6`)
 * ne pouvait annoncer aucun prefixe, si bien que SLAAC ne venait que des routeurs Cisco et Huawei. Sources : radvd v2.19 (gram.y, scanner.l, defaults.h, interface.c check_iface, send.c,
 * radvd.c, process.c, device-common.c) et le paquet Ubuntu 24.04 `1:2.19-1ubuntu1` extrait et execute pour son unite, ses fichiers d'exemple et son `-c` (oracle : `probe-radvd-configtest-oracle`).
 * Ce que la source fixe et que ce fichier mesure : l'annonce part des l'ouverture puis aux seconds 16 et 32 (MAX_INITIAL_RTR_ADVERT_INTERVAL, 3 annonces initiales), ensuite a un
 * intervalle tire dans [MinRtrAdvInterval, MaxRtrAdvInterval] ; `AdvRASolicitedUnicast` (defaut on) repond a une sollicitation par une annonce unicast ; la duree de vie du routeur est
 * celle de `AdvDefaultLifetime` tant que le transfert IPv6 est actif et ZERO sinon ; l'arret envoie une derniere annonce de duree de vie zero ; une interface absente est ignoree
 * (`IgnoreIfMissing` on) ou fatale (off) ; `check_iface` refuse un `MinRtrAdvInterval` hors bornes avec le texte de radvd ; une annonce d'un autre routeur dont les drapeaux different
 * est signalee (process_ra). Les durees de vie de prefixe par defaut sont 86400 / 14400 (DFLT_*), pas les 30 / 7 jours des routeurs Cisco.
 * Reserves (TODO.md) : Mobile IPv6, 6LoWPAN et ABRO sont lus et non emis ; `radvdump` n'existe pas ; la condition `ConditionPathExists=/etc/radvd.conf` de l'unite n'est pas modelisee.
 *
 * Discrimine par `git stash` sur src/network et src/terminal : tous les cas tombent avant, sauf le TEMOIN : `radvd` absent d'une machine sans le paquet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { IPv6Packet, ICMPv6Packet, NDPRouterAdvertisement } from '@/network/core/types';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock } from '../../support/ntpTime';
import { radvdLab, rootOn, type Machine } from '../../support/radvdLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  EquipmentRegistry.getInstance().clear();
});

const lab = (config: string | null, options: { forwarding?: boolean; install?: boolean } = {}) => radvdLab(clock, config, options);

const SIMPLE = 'interface eth0 {\n  AdvSendAdvert on;\n  prefix 2001:db8:77::/64 { };\n};';

describe('the package gates the command', () => {
  it('WITNESS — without the package there is no radvd', async () => {
    const { onRouter } = await lab(null, { install: false });
    expect(await onRouter('radvd -v; echo rc=$?')).toBe('bash: radvd: command not found\nrc=127');
    expect(await onRouter('which radvd; echo rc=$?')).toBe('rc=1');
  });

  it('apt install ships the binary, the examples and the unit', async () => {
    const { onRouter } = await lab(null);
    expect(await onRouter('which radvd')).toBe('/usr/sbin/radvd');
    expect(await onRouter('radvd -v | head -1; echo rc=${PIPESTATUS[0]}')).toBe('Version: 2.19\nrc=1');
    expect(await onRouter('cat /usr/share/doc/radvd/examples/simple-radvd.conf')).toContain('prefix 2001:db8::/64');
    expect(await onRouter('dpkg -l radvd')).toMatch(/ii\s+radvd\s+1:2\.19-1ubuntu1/);
    expect(await onRouter('systemctl is-enabled radvd')).toBe('enabled');
  });
});

describe('a host on the link autoconfigures from a Linux router', () => {
  it('gets the advertised prefix with radvd defaults and a default route', async () => {
    const { onRouter, onHost } = await lab(SIMPLE);
    await onRouter('systemctl start radvd');
    const addresses = await onHost('ip -6 addr show eth0');
    expect(addresses).toMatch(/inet6 2001:db8:77:[0-9a-f:]+\/64 scope global.*\n\s+valid_lft 86400sec preferred_lft 14400sec/);
    const routes = await onHost('ip -6 route show');
    expect(routes).toMatch(/^default via fe80::\S+ dev eth0 proto ra/m);
    expect(routes).toContain('2001:db8:77::/64 dev eth0 proto ra');
  });

  it('the unit is active and the service logs its start', async () => {
    const { onRouter } = await lab(SIMPLE);
    await onRouter('systemctl start radvd');
    expect(await onRouter('systemctl is-active radvd')).toBe('active');
    expect(await onRouter('journalctl -u radvd --no-pager')).toContain('version 2.19 started');
  });
});

describe('what the advertisement carries', () => {
  const FULL = `interface eth0 {
  AdvSendAdvert on;
  MinRtrAdvInterval 10;
  MaxRtrAdvInterval 30;
  AdvManagedFlag on;
  AdvOtherConfigFlag on;
  AdvLinkMTU 1400;
  AdvCurHopLimit 32;
  AdvDefaultLifetime 90;
  AdvDefaultPreference high;
  prefix 2001:db8:78::/64 { AdvOnLink off; AdvAutonomous off; AdvValidLifetime 7200; AdvPreferredLifetime 3600; };
  route 2001:db8:ff::/48 { AdvRouteLifetime 1800; AdvRoutePreference low; };
  RDNSS 2001:db8::53 { AdvRDNSSLifetime 60; };
  DNSSL example.com lab.local { AdvDNSSLLifetime 60; };
};`;

  it('the header, the prefix and the optional records of the configuration', async () => {
    const { onRouter, seen } = await lab(FULL);
    await onRouter('systemctl start radvd');
    const ra = seen[0].ra;
    expect(seen[0].destination).toBe('ff02::1');
    expect(ra.managedFlag).toBe(true);
    expect(ra.otherConfigFlag).toBe(true);
    expect(ra.curHopLimit).toBe(32);
    expect(ra.routerLifetime).toBe(90);
    expect(ra.routerPreference).toBe(1);
    const kinds = ra.options.map((option) => option.optionType);
    expect(kinds).toEqual(['prefix-info', 'route-info', 'rdnss', 'dnssl', 'mtu', 'source-link-layer']);
    const prefix = ra.options[0];
    expect(prefix).toMatchObject({ onLink: false, autonomous: false, validLifetime: 7200, preferredLifetime: 3600, prefixLength: 64 });
    expect(ra.options[1]).toMatchObject({ prefixLength: 48, preference: -1, lifetime: 1800 });
    expect(ra.options[2]).toMatchObject({ lifetime: 60 });
    expect(ra.options[3]).toMatchObject({ lifetime: 60, domains: ['example.com', 'lab.local'] });
    expect(ra.options[4]).toMatchObject({ mtu: 1400 });
  });

  it('A=off: the host takes the prefix for nothing and builds no address', async () => {
    const { onRouter, onHost } = await lab(FULL);
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 addr show eth0')).not.toContain('2001:db8:78:');
  });

  it('without IPv6 forwarding the router lifetime is zero and no default route is learned', async () => {
    const { onRouter, onHost, seen } = await lab(SIMPLE, { forwarding: false });
    await onRouter('systemctl start radvd');
    expect(seen[0].ra.routerLifetime).toBe(0);
    expect(await onHost('ip -6 route show')).not.toMatch(/^default/m);
    expect(await onRouter('journalctl -u radvd --no-pager')).toContain('IPv6 forwarding seems to be disabled, but continuing anyway');
  });
});

describe('timing', () => {
  const FAST = 'interface eth0 {\n  AdvSendAdvert on;\n  MinRtrAdvInterval 10;\n  MaxRtrAdvInterval 30;\n  prefix 2001:db8:77::/64 { };\n};';

  it('one advertisement at start, then at 16 s and 32 s, then at random intervals within [Min, Max]', async () => {
    const { onRouter, seen } = await lab(FAST);
    await onRouter('systemctl start radvd');
    expect(seen.length).toBe(1);
    clock.advance(15_900);
    expect(seen.length).toBe(1);
    clock.advance(200);
    expect(seen.length).toBe(2);
    clock.advance(16_000);
    expect(seen.length).toBe(3);
    const thirdAt = seen[2].at;
    clock.advance(9_900);
    expect(seen.length).toBe(3);
    clock.advance(20_200);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen[3].at - thirdAt).toBeGreaterThanOrEqual(10_000);
    expect(seen[3].at - thirdAt).toBeLessThanOrEqual(30_000);
  });

  it('stopping the service cancels the timers', async () => {
    const { onRouter, seen } = await lab(FAST);
    await onRouter('systemctl start radvd');
    await onRouter('systemctl stop radvd');
    const count = seen.length;
    clock.advance(120_000);
    expect(seen.length).toBe(count);
  });
});

describe('solicitations and the final advertisement', () => {
  it('a Router Solicitation is answered by a unicast advertisement', async () => {
    const { onRouter, host, seen } = await lab(SIMPLE);
    await onRouter('systemctl start radvd');
    const before = seen.length;
    host.sendRouterSolicitation('eth0');
    const unicast = seen.slice(before).filter((entry) => entry.destination !== 'ff02::1');
    expect(unicast.length).toBe(1);
    expect(unicast[0].destination).toMatch(/^fe80::/);
  });

  it('systemctl stop sends a last advertisement with a zero router lifetime', async () => {
    const { onRouter, seen } = await lab(SIMPLE);
    await onRouter('systemctl start radvd');
    await onRouter('systemctl stop radvd');
    const last = seen[seen.length - 1].ra;
    expect(last.routerLifetime).toBe(0);
    expect(await onRouter('journalctl -u radvd --no-pager')).toContain('sending stop adverts');
  });

  it('with a clients list only the listed addresses are advertised to, by unicast', async () => {
    const config = 'interface eth0 {\n  AdvSendAdvert on;\n  clients { fe80::ff:fe00:99; };\n  prefix 2001:db8:77::/64 { };\n};';
    const { onRouter, seen } = await lab(config);
    await onRouter('systemctl start radvd');
    expect(seen.length).toBe(0);
  });
});

describe('configuration errors and interface checks', () => {
  it('an invalid configuration fails the start, with systemd\'s wording and radvd\'s reason in the journal', async () => {
    const { onRouter } = await lab('interface eth0 { AdvSendAdvert maybe; };');
    expect(await onRouter('systemctl start radvd')).toContain('Job for radvd.service failed because the control process exited with error code.');
    expect(await onRouter('systemctl is-active radvd')).toBe('failed');
    expect(await onRouter('journalctl -u radvd --no-pager')).toContain('exiting, failed to read config file');
  });

  it('an interface that does not exist is ignored by default', async () => {
    const { onRouter, seen } = await lab('interface eth9 {\n  AdvSendAdvert on;\n  prefix 2001:db8:77::/64 { };\n};');
    await onRouter('systemctl start radvd');
    expect(await onRouter('systemctl is-active radvd')).toBe('active');
    expect(seen.length).toBe(0);
  });

  it('IgnoreIfMissing off makes it fatal', async () => {
    const { onRouter } = await lab('interface eth9 {\n  IgnoreIfMissing off;\n  AdvSendAdvert on;\n  prefix 2001:db8:77::/64 { };\n};');
    await onRouter('systemctl start radvd');
    expect(await onRouter('systemctl is-active radvd')).toBe('failed');
    expect(await onRouter('journalctl -u radvd --no-pager')).toContain('interface eth9 does not exist or is not set up properly');
  });

  it('check_iface refuses MinRtrAdvInterval above three quarters of the maximum', async () => {
    const { onRouter } = await lab('interface eth0 {\n  AdvSendAdvert on;\n  MaxRtrAdvInterval 30;\n  MinRtrAdvInterval 100;\n  prefix 2001:db8:77::/64 { };\n};');
    await onRouter('systemctl start radvd');
    expect(await onRouter('journalctl -u radvd --no-pager'))
      .toContain('MinRtrAdvInterval for eth0 (100.00) must be at least 3 but no more than 3/4 of MaxRtrAdvInterval (22.50)');
  });

  it('check_iface refuses AdvLinkMTU above the link MTU', async () => {
    const { onRouter } = await lab('interface eth0 {\n  AdvSendAdvert on;\n  AdvLinkMTU 9000;\n  prefix 2001:db8:77::/64 { };\n};');
    await onRouter('systemctl start radvd');
    expect(await onRouter('journalctl -u radvd --no-pager')).toContain('AdvLinkMTU for eth0 (9000) must be zero or between 1280 and 1500');
  });
});

describe('reload and a second router', () => {
  it('systemctl reload rereads the configuration and advertises the new prefix', async () => {
    const { onRouter, seen } = await lab(SIMPLE);
    await onRouter('systemctl start radvd');
    await onRouter(`sh -c 'cat > /etc/radvd.conf <<"EOF"\ninterface eth0 {\n  AdvSendAdvert on;\n  prefix 2001:db8:99::/64 { };\n};\nEOF'`);
    await onRouter('systemctl reload radvd');
    clock.advance(1_100);
    const prefixes = seen.flatMap((entry) => entry.ra.options.filter((o) => o.optionType === 'prefix-info'))
      .map((o) => (o as { prefix: { toString(): string } }).prefix.toString());
    expect(prefixes).toContain('2001:db8:99::');
    expect(await onRouter('journalctl -u radvd --no-pager')).toContain('attempting to reread config file');
  });

  it('an advertisement from another router whose flags differ is reported', async () => {
    const { router, host, onRouter } = await lab(SIMPLE);
    const other = new LinuxServer('linux-server', 'R2');
    other.powerOn();
    new Cable('c2').connect(other.getPort('eth0')!, router.getPort('eth1')!);
    void host;
    const onOther = rootOn(other);
    await onOther('apt install -y radvd');
    await onOther('sysctl -w net.ipv6.conf.all.forwarding=1');
    await onOther(`sh -c 'cat > /etc/radvd.conf <<"EOF"\ninterface eth0 {\n  AdvSendAdvert on;\n  AdvManagedFlag on;\n  prefix 2001:db8:55::/64 { };\n};\nEOF'`);
    await onRouter(`sh -c 'cat > /etc/radvd.conf <<"EOF"\ninterface eth1 {\n  AdvSendAdvert on;\n  prefix 2001:db8:56::/64 { };\n};\nEOF'`);
    await onRouter('systemctl start radvd');
    await onOther('systemctl start radvd');
    expect(await onRouter('journalctl -u radvd --no-pager')).toMatch(/our AdvManagedFlag on eth1 doesn't agree with fe80::/);
  });
});
