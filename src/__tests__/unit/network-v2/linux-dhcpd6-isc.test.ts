/*
 * ISC dhcpd en mode IPv6 (`dhcpd -6`, unite isc-dhcp-server6, /etc/dhcp/dhcpd6.conf)
 * sur le moteur DHCPv6 commun : subnet6, range6, prefix6, host avec
 * host-identifier option dhcp6.client-id et fixed-address6 / fixed-prefix6,
 * options dhcp6.name-servers et dhcp6.domain-search, preferred-lifetime,
 * default-lease-time, dhcp-renewal-time / dhcp-rebinding-time, `dhcpd -6 -t`,
 * INTERFACESv6, fichier de baux dhcpd6.leases (ia-na / ia-pd). Syntaxe : page de
 * manuel dhcpd.conf(5) d'ISC de memoire (non joignable ici) ; le texte exact des
 * messages de demarrage du mode -6 n'est pas verifie.
 *
 * Avant le correctif : ni dhcpd6.conf, ni unite isc-dhcp-server6, ni ecoute
 * sur 547 (« Unit isc-dhcp-server6.service not found ») : les 15 cas tombent,
 * sauf le temoin « dhcpd v4 inchange » qui passe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, IPv6Address, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const CONF = `default-lease-time 7200;
preferred-lifetime 3600;
option dhcp-renewal-time 1000;
option dhcp-rebinding-time 2000;
option dhcp6.name-servers 2001:db8:53::1, 2001:db8:53::2;
option dhcp6.domain-search "corp.example";
subnet6 2001:db8:1::/64 {
  range6 2001:db8:1::100 2001:db8:1::101;
  prefix6 2001:db8:aa00:: 2001:db8:aa02:: /48;
}
`;

const put = (srv: LinuxServer, path: string, text: string) =>
  srv.executeCommand(`printf '%s' ${JSON.stringify(text)} > ${path}`);

async function lab(conf = CONF, interfaces = '"eth0"') {
  const srv = new LinuxServer('linux-server', 'SRV');
  const c1 = new LinuxPC('linux-pc', 'C1');
  const c2 = new LinuxPC('linux-pc', 'C2');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('a').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(c1.getPorts()[0], sw.getPorts()[1]);
  new Cable('c').connect(c2.getPorts()[0], sw.getPorts()[2]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].enableIPv6();
  srv.getPorts()[0].configureIPv6(new IPv6Address('2001:db8:1::1'), 64);
  await put(srv, '/etc/dhcp/dhcpd6.conf', conf);
  await put(srv, '/etc/default/isc-dhcp-server', `INTERFACESv6=${interfaces}\n`);
  return { srv, c1, c2, sw };
}

const start = (srv: LinuxServer) => srv.executeCommand('systemctl start isc-dhcp-server6');

describe('temoin', () => {
  it('dhcpd v4 inchange : dhcpd -t verifie dhcpd.conf', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('dhcpd -t')).toContain('Config file: /etc/dhcp/dhcpd.conf');
  });
});

describe('dhcpd -6 -t', () => {
  it('verifie dhcpd6.conf', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('dhcpd -6 -t')).toContain('Config file: /etc/dhcp/dhcpd6.conf');
  });

  it('signale une erreur de syntaxe avec son numero de ligne', async () => {
    const { srv } = await lab('subnet6 zzz { }\n');
    const out = await srv.executeCommand('dhcpd -6 -t');
    expect(out).toContain('/etc/dhcp/dhcpd6.conf line 1: expecting an IPv6 prefix.');
    expect(out).toContain('Configuration file errors encountered -- exiting');
  });

  it('un DUID de host mal forme est refuse', async () => {
    const { srv } = await lab('host h { host-identifier option dhcp6.client-id zz; fixed-address6 2001:db8:1::9; }\n');
    expect(await srv.executeCommand('dhcpd -6 -t')).toContain('expecting a DUID.');
  });
});

describe('demarrage', () => {
  it('sans subnet6 pour l interface, le service refuse de demarrer', async () => {
    const { srv } = await lab('default-lease-time 600;\n');
    await start(srv);
    expect(await srv.executeCommand('systemctl is-active isc-dhcp-server6')).toContain('failed');
  });

  it('avec subnet6, le service ecoute sur UDP 547', async () => {
    const { srv } = await lab();
    await start(srv);
    expect(await srv.executeCommand('systemctl is-active isc-dhcp-server6')).toContain('active');
    expect(srv.dhcpd6.isRunning()).toBe(true);
    expect(await srv.executeCommand('ss -ulnp')).toContain(':547');
  });

  it('INTERFACESv6 restreint les interfaces servies', async () => {
    const { srv, c1 } = await lab(CONF, '"eth9"');
    await start(srv);
    c1.requestDhcpv6Lease('eth0', true);
    expect(srv.dhcpd6.getEngine().getBindings()).toEqual([]);
  });

  it('systemctl stop : plus de reponse', async () => {
    const { srv, c1 } = await lab();
    await start(srv);
    await srv.executeCommand('systemctl stop isc-dhcp-server6');
    c1.requestDhcpv6Lease('eth0', true);
    expect(srv.dhcpd6.getEngine().getBindings()).toEqual([]);
  });
});

describe('bail sur le fil', () => {
  it('range6 : le client recoit une adresse de la plage', async () => {
    const { srv, c1 } = await lab();
    await start(srv);
    await c1.executeCommand('dhclient -6 eth0');
    expect(['2001:db8:1::100', '2001:db8:1::101']).toContain(c1.getDhcpv6Lease('eth0')?.address);
    expect(srv.dhcpd6.getEngine().getBindings().length).toBe(1);
  });

  it('la plage de deux adresses est epuisee par deux clients, le troisieme n en a pas', async () => {
    const { srv, c1, c2, sw } = await lab();
    const c3 = new LinuxPC('linux-pc', 'C3');
    new Cable('d').connect(c3.getPorts()[0], sw.getPorts()[3]);
    await start(srv);
    await c1.executeCommand('dhclient -6 eth0');
    await c2.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')?.address).not.toBe(c2.getDhcpv6Lease('eth0')?.address);
    c3.requestDhcpv6Lease('eth0', true);
    expect(c3.getDhcpv6Lease('eth0')).toBeNull();
    expect(srv.dhcpd6.getEngine().getBindings().length).toBe(2);
  });

  it('durees : default-lease-time = valide, preferred-lifetime, renewal et rebinding = T1 et T2', async () => {
    const { srv, c1 } = await lab();
    await start(srv);
    await c1.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')).toMatchObject({ validLifetime: 7200, preferredLifetime: 3600, t1: 1000, t2: 2000 });
  });

  it('options : name-servers et domain-search arrivent dans resolv.conf du client', async () => {
    const { srv, c1 } = await lab();
    await start(srv);
    await c1.executeCommand('dhclient -6 eth0');
    const resolv = await c1.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('2001:db8:53::1');
    expect(resolv).toContain('corp.example');
  });

  it('prefix6 : delegation d un /48 du bloc, ecrite dans les baux', async () => {
    const { srv, c1 } = await lab();
    await start(srv);
    c1.requestDhcpv6Lease('eth0', false, { prefixDelegation: true });
    expect(c1.getDhcpv6Lease('eth0')?.prefix).toEqual({ prefix: '2001:db8:aa00::', prefixLength: 48 });
    expect(await srv.executeCommand('cat /var/lib/dhcp/dhcpd6.leases')).toContain('iaprefix 2001:db8:aa00::/48');
  });

  it('host fixed-address6 par DUID : adresse fixe', async () => {
    const { srv, c1 } = await lab();
    const duid = ['00', '03', '00', '01', ...c1.getPorts()[0].getMAC().toString().split(':')].join(':');
    await put(srv, '/etc/dhcp/dhcpd6.conf',
      `${CONF}host c1 { host-identifier option dhcp6.client-id ${duid}; fixed-address6 2001:db8:1::5; }\n`);
    await start(srv);
    await c1.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')?.address).toBe('2001:db8:1::5');
  });

  it('dhcpd6.leases porte le bail ia-na avec preferred-life, max-life et ends', async () => {
    const { srv, c1 } = await lab();
    await start(srv);
    await c1.executeCommand('dhclient -6 eth0');
    const leases = await srv.executeCommand('cat /var/lib/dhcp/dhcpd6.leases');
    expect(leases).toContain(`iaaddr ${c1.getDhcpv6Lease('eth0')!.address} {`);
    expect(leases).toContain('binding state active;');
    expect(leases).toContain('preferred-life 3600;');
    expect(leases).toContain('max-life 7200;');
    expect(leases).toMatch(/ends \d \d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d;/);
  });
});
