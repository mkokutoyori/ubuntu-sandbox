import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { parseDhcpdConf, parseDhcpdInterfaces } from '@/network/devices/linux/dhcp/DhcpdConfig';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const CONF = '/etc/dhcp/dhcpd.conf';

async function lab() {
  const srv = new LinuxServer('linux-server', 'SRV-DHCP');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(pc.getPorts()[0], sw.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.60.1'), new SubnetMask('255.255.255.0'));
  srv.powerOn();
  pc.powerOn();
  return { srv, pc };
}

async function writeConf(srv: LinuxServer, body: string) {
  await srv.executeCommand(`printf '%s' ${JSON.stringify(body)} > ${CONF}`);
}

const CONF_LAN60 = `
authoritative;
option domain-name "lab.local";
option domain-name-servers 192.168.60.1;
default-lease-time 600;
max-lease-time 7200;

subnet 192.168.60.0 netmask 255.255.255.0 {
  range 192.168.60.100 192.168.60.150;
  option routers 192.168.60.254;
}
`;

describe('isc-dhcp-server : le demon existe et lit sa configuration', () => {
  it('l unite est declaree et arretee au demarrage', async () => {
    const { srv } = await lab();

    const vu = await srv.executeCommand('systemctl status isc-dhcp-server');

    expect(vu).toMatch(/isc-dhcp-server/);
    expect(vu).not.toMatch(/could not be found|not-found/i);
    expect(vu).toMatch(/inactive|dead/i);
  });

  it('la configuration livree par Debian est celle du paquet', async () => {
    const { srv } = await lab();

    const vu = await srv.executeCommand(`cat ${CONF}`);

    expect(vu).toContain('ddns-update-style none;');
    expect(vu).toContain('log-facility local7;');
    expect(vu).not.toMatch(/^subnet /m);
  });

  it('`dhcpd -t` valide la configuration et nomme ses fichiers', async () => {
    const { srv } = await lab();
    await writeConf(srv, CONF_LAN60);

    const vu = await srv.executeCommand('sudo dhcpd -t');

    expect(vu).toContain('Internet Systems Consortium DHCP Server 4.4.1');
    expect(vu).toContain('Config file: /etc/dhcp/dhcpd.conf');
    expect(vu).toContain('Database file: /var/lib/dhcp/dhcpd.leases');
  });

  it('`dhcpd -t` REFUSE un point-virgule manquant en donnant la ligne', async () => {
    const { srv } = await lab();
    await writeConf(srv, 'authoritative;\ndefault-lease-time 600\nmax-lease-time 7200;\n');

    const vu = await srv.executeCommand('sudo dhcpd -t');

    expect(vu).toContain('/etc/dhcp/dhcpd.conf line 2: semicolon expected.');
    expect(vu).toContain('Configuration file errors encountered -- exiting');
  });

  it('une configuration refusee empeche le demarrage', async () => {
    const { srv } = await lab();
    await writeConf(srv, 'subnet 192.168.60.0 netmask {\n}\n');

    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    const vu = await srv.executeCommand('systemctl is-active isc-dhcp-server');
    expect(vu).not.toMatch(/^active/);
  });
});

describe('isc-dhcp-server : sans declaration de sous-reseau, il n ecoute nulle part', () => {
  it('le demarrage echoue en nommant l interface et la raison', async () => {
    const { srv } = await lab();

    const vu = await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    expect(vu).toContain('No subnet declaration for eth0 (192.168.60.1).');
    expect(vu).toContain('Not configured to listen on any interfaces!');
  });

  it('rien n ecoute sur le port 67 apres cet echec', async () => {
    const { srv } = await lab();
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    const vu = await srv.executeCommand('ss -lunp');

    expect(vu).not.toMatch(/:67\b/);
  });

  it('INTERFACESv4 restreint les interfaces servies', async () => {
    const { srv } = await lab();
    await writeConf(srv, CONF_LAN60);
    await srv.executeCommand(
      `printf '%s' 'INTERFACESv4="eth9"' > /etc/default/isc-dhcp-server`);

    const vu = await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    expect(vu).toContain('Not configured to listen on any interfaces!');
  });
});

describe('isc-dhcp-server : un vrai bail sur le fil', () => {
  it('le poste obtient une adresse DE LA PLAGE declaree', async () => {
    const { srv, pc } = await lab();
    await writeConf(srv, CONF_LAN60);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    await pc.executeCommand('dhclient eth0');

    const adresse = pc.getPorts()[0].getIPAddress()?.toString() ?? '';
    expect(adresse).toMatch(/^192\.168\.60\.1[0-5]\d$/);
  });

  it('le port 67 est SERVI, et `ss` le montre', async () => {
    const { srv } = await lab();
    await writeConf(srv, CONF_LAN60);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    const vu = await srv.executeCommand('ss -lunp');

    expect(vu).toMatch(/:67\b/);
  });

  it('les options du sous-reseau ARRIVENT chez le client', async () => {
    const { srv, pc } = await lab();
    await writeConf(srv, CONF_LAN60);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    await pc.executeCommand('dhclient eth0');

    const routes = await pc.executeCommand('ip route');
    expect(routes).toContain('default via 192.168.60.254');
    const resolv = await pc.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('192.168.60.1');
    expect(resolv).toContain('lab.local');
  });

  it('une reservation `host` donne TOUJOURS la meme adresse', async () => {
    const { srv, pc } = await lab();
    const mac = pc.getPorts()[0].getMAC().toString().toLowerCase();
    await writeConf(srv, `${CONF_LAN60}
host poste-fixe {
  hardware ethernet ${mac};
  fixed-address 192.168.60.77;
}
`);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    await pc.executeCommand('dhclient eth0');

    expect(pc.getPorts()[0].getIPAddress()?.toString()).toBe('192.168.60.77');
  });

  it('le bail est ECRIT dans dhcpd.leases, au format du vrai fichier', async () => {
    const { srv, pc } = await lab();
    await writeConf(srv, CONF_LAN60);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');
    await pc.executeCommand('dhclient eth0');

    const vu = await srv.executeCommand('cat /var/lib/dhcp/dhcpd.leases');

    expect(vu).toMatch(/lease 192\.168\.60\.\d+ \{/);
    expect(vu).toMatch(/binding state active;/);
    expect(vu).toMatch(/hardware ethernet [0-9a-f:]+;/);
  });

  it('`dhcp-lease-list` relit ce fichier', async () => {
    const { srv, pc } = await lab();
    await writeConf(srv, CONF_LAN60);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');
    await pc.executeCommand('dhclient eth0');

    const vu = await srv.executeCommand('dhcp-lease-list');

    expect(vu).toContain('MAC');
    expect(vu).toMatch(/192\.168\.60\.\d+/);
    expect(vu.toLowerCase()).toContain(pc.getPorts()[0].getMAC().toString().toLowerCase());
  });

  it('l arret du service ferme le port et le bail cesse', async () => {
    const { srv, pc } = await lab();
    await writeConf(srv, CONF_LAN60);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');
    await srv.executeCommand('sudo systemctl stop isc-dhcp-server');

    await pc.executeCommand('dhclient eth0');

    expect(pc.getPorts()[0].getIPAddress()?.toString() ?? '')
      .not.toMatch(/^192\.168\.60\./);
    expect(await srv.executeCommand('ss -lunp')).not.toMatch(/:67\b/);
  });

  it('une adresse HORS de la plage n est jamais distribuee', async () => {
    const { srv, pc } = await lab();
    await writeConf(srv, `
subnet 192.168.60.0 netmask 255.255.255.0 {
  range 192.168.60.100 192.168.60.101;
  option routers 192.168.60.254;
}
`);
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    await pc.executeCommand('dhclient eth0');

    const adresse = pc.getPorts()[0].getIPAddress()?.toString() ?? '';
    expect(['192.168.60.100', '192.168.60.101']).toContain(adresse);
  });
});

describe('l analyseur de dhcpd.conf', () => {
  it('lit un sous-reseau, sa plage et ses options', () => {
    const config = parseDhcpdConf(CONF_LAN60, CONF);

    expect(config.errors).toEqual([]);
    expect(config.authoritative).toBe(true);
    expect(config.subnets.length).toBe(1);
    expect(config.subnets[0].network).toBe('192.168.60.0');
    expect(config.subnets[0].ranges).toEqual([{ start: '192.168.60.100', end: '192.168.60.150' }]);
    expect(config.subnets[0].options.routers).toEqual(['192.168.60.254']);
    expect(config.globals.domainName).toBe('lab.local');
    expect(config.globals.defaultLeaseTime).toBe(600);
  });

  it('un commentaire ne fait pas partie de la configuration', () => {
    const config = parseDhcpdConf('# subnet 10.0.0.0 netmask 255.0.0.0 { }\nauthoritative;\n', CONF);

    expect(config.subnets.length).toBe(0);
    expect(config.errors).toEqual([]);
  });

  it('une adresse materielle malformee est refusee', () => {
    const config = parseDhcpdConf(
      'host p {\n  hardware ethernet zz:zz;\n  fixed-address 10.0.0.5;\n}\n', CONF);

    expect(config.hosts.length).toBe(0);
    expect(config.errors.some(e => e.message === 'expecting a hardware address.')).toBe(true);
  });

  it('une option inconnue est nommee', () => {
    const config = parseDhcpdConf('option zorglub 1;\n', CONF);

    expect(config.errors.some(e => e.message === 'unknown option zorglub.')).toBe(true);
  });

  it('un sous-reseau declare dans un shared-network est trouve', () => {
    const config = parseDhcpdConf(`
shared-network campus {
  subnet 10.1.0.0 netmask 255.255.255.0 {
    range 10.1.0.10 10.1.0.20;
  }
}
`, CONF);

    expect(config.errors).toEqual([]);
    expect(config.subnets.length).toBe(1);
    expect(config.subnets[0].network).toBe('10.1.0.0');
  });

  it('INTERFACESv4 se lit avec ou sans guillemets', () => {
    expect(parseDhcpdInterfaces('INTERFACESv4="eth0 eth1"')).toEqual(['eth0', 'eth1']);
    expect(parseDhcpdInterfaces('INTERFACESv4=eth2')).toEqual(['eth2']);
    expect(parseDhcpdInterfaces('#INTERFACESv4="eth0"')).toEqual([]);
    expect(parseDhcpdInterfaces('INTERFACESv4=""')).toEqual([]);
  });
});
