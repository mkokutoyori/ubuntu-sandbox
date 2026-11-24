/*
 * Probe: RadSec (RFC 6614) and a RadSec home_server only worked over IPv4: the stream transport passed IPv4 addresses to the agent. Source of truth:
 * RFC 6614 (RadSec runs on TCP whatever the IP version), FreeRADIUS v3.2.x listen.c / realms.c (a `listen { proto = tcp ipv6addr = :: tls { } }`
 * listener and a `home_server { proto = tcp ipv6addr = ... tls { } }` have the family of their address). The TLS listener now registers on the IPv6
 * wildcard when written ipv6addr, the stream engine takes the peer address of either family, and the proxy opens its RadSec connection to an IPv6
 * home server (mutual TLS, one reused connection, the client table matched by IPv6 address with proto = tls). Plain RADIUS/TCP stays IPv4 (TODO.md).
 *
 * Discriminated with git stash on src: 3 of 3 fall before the fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, privateKeyToPem } from '@/network/pki/pem';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const DIR = '/etc/freeradius/3.0';
const SITE = `${DIR}/sites-available/default`;
const PROXY = `${DIR}/proxy.conf`;
const NOW = simulationNowMs();
const FIVE_YEARS = 5 * 365 * 24 * 3600 * 1000;

const LISTEN = `\tlisten {\n\t\ttype = auth+acct\n\t\tipv6addr = ::\n\t\tport = 2083\n\t\tproto = tcp\n\t\ttls {\n\t\t\tprivate_key_file = ${DIR}/certs/server.key\n\t\t\tcertificate_file = ${DIR}/certs/server.pem\n\t\t\tca_file = ${DIR}/certs/ca.pem\n\t\t\trequire_client_cert = yes\n\t\t}\n\t}\n`;
const HOME_TLS = (ca = `${DIR}/certs/ca.pem`) => `\ttls {\n\t\tprivate_key_file = ${DIR}/certs/client.key\n\t\tcertificate_file = ${DIR}/certs/client.pem\n\t\tca_file = ${ca}\n\t}\n`;
const PROXY_CONF = (homeBody = `\tproto = tcp\n${HOME_TLS()}`) => `home_server home1 {\n  ipv6addr = fd00::3\n  response_window = 1\n${homeBody}}\nhome_server_pool pool1 {\n  home_server = home1\n}\nrealm example.com {\n  auth_pool = pool1\n  acct_pool = pool1\n}\nrealm LOCAL {\n}\n`;

function install(server: LinuxServer, ca: CertificateAuthority, leaves: { name: string; subject: string; alt?: string[] }[], caName = 'ca.pem') {
  vfsOf(server).mkdirp(`${DIR}/certs`, 0o755, 0, 0);
  write(server, `${DIR}/certs/${caName}`, certToPem(ca.rootCertificate));
  for (const leaf of leaves) {
    const issued = ca.issueCertificate({ subject: leaf.subject, notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS, ...(leaf.alt === undefined ? {} : { subjectAltNames: leaf.alt }) });
    write(server, `${DIR}/certs/${leaf.name}.pem`, certToPem(issued.cert));
    write(server, `${DIR}/certs/${leaf.name}.key`, privateKeyToPem(issued.privateKey));
  }
}

async function lab(proxyConf = PROXY_CONF(), options: { foreignCa?: boolean } = {}) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'NAS');
  const edge = new LinuxServer('linux-server', 'EDGE');
  const home = new LinuxServer('linux-server', 'HOME');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, edge, home, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(edge.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(home.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  edge.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  home.configureInterface('eth0', new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
  edge.configureIPv6Interface('eth0', new IPv6Address('fd00::2'), 64);
  home.configureIPv6Interface('eth0', new IPv6Address('fd00::3'), 64);
  const authority = CertificateAuthority.generate('CN=Lab CA', { now: NOW });
  const foreign = CertificateAuthority.generate('CN=Foreign CA', { now: NOW });
  install(home, authority, [{ name: 'server', subject: 'CN=home.lab', alt: ['DNS:home.lab'] }]);
  install(edge, options.foreignCa === true ? foreign : authority, [{ name: 'client', subject: 'CN=edge' }]);
  write(edge, `${DIR}/certs/ca.pem`, certToPem((options.foreignCa === true ? foreign : authority).rootCertificate));
  write(home, CLIENTS_CONF_PATH, 'client edge {\n  ipv6addr = fd00::2\n  proto = tls\n  secret = radsec\n}\nclient nas {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(home, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  write(home, SITE, (vfsOf(home).readFile(SITE) ?? '').replace('server default {\n', `server default {\n${LISTEN}`));
  write(edge, CLIENTS_CONF_PATH, 'client nas {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(edge, PROXY, proxyConf);
  await home.executeCommand('systemctl restart freeradius');
  const started = await edge.executeCommand('systemctl restart freeradius');
  await edge.executeCommand('ping -6 -c 1 fd00::3');
  return { client, edge, home, started, authority };
}

const login = (user: string, password = 'wonderland') => `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -x -r 1 10.0.0.2 auth shared`;
const start = (user: string) => `printf 'User-Name = "${user}"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s1"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 1\\n' | radclient -r 1 10.0.0.2 acct shared`;


describe('RadSec over IPv6', () => {
  it('relays an Access-Request over a mutual TLS connection to an IPv6 home server, whose Access-Accept returns to the NAS', async () => {
    const { client, started } = await lab();
    expect(started).not.toContain('Failed');
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });

  it('relays a reject for a wrong password', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(login('alice@example.com', 'wrong'))).toContain('Access-Reject');
  });

  it('keeps one TLS connection to the IPv6 home server for several requests', async () => {
    const { client, home } = await lab();
    await client.executeCommand(login('alice@example.com'));
    await client.executeCommand(login('alice@example.com'));
    const established = (await home.executeCommand('ss -tn state established')).split('\n').filter((line) => line.includes(':2083')).length;
    expect(established).toBe(1);
  });
});
