/*
 * Probe: the proxy opened a TLS connection for every request and closed it after the reply, so each proxied request paid a TCP and a
 * TLS handshake. Source of truth: RFC 6613 section 2.1 / RFC 6614 section 2.1 (a RadSec connection is long lived: "the connection is kept
 * open" and carries any number of requests), FreeRADIUS v3.2.x src/main/listen.c and realms.c (a home server with proto = tcp holds one
 * connection per home server and sends every request on it, reconnecting when it drops). The client now keeps one connection per home
 * server and port, reuses it, drops it when it closed, reconnects once when a reused one fails, and closes it when the server stops.
 *
 * Discriminated with git stash on src: 2 of 5 fall before the fix (the connection left open, and shared by accounting and authentication);
 * three pass either way and are named: the witness (a proxied request is answered), the stop case (on base nothing is left open, so
 * nothing remains after the stop) and the reconnect after a home server restart (on base every request opens a fresh connection anyway).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
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

const LISTEN = `\tlisten {\n\t\ttype = auth+acct\n\t\tipaddr = *\n\t\tport = 2083\n\t\tproto = tcp\n\t\ttls {\n\t\t\tprivate_key_file = ${DIR}/certs/server.key\n\t\t\tcertificate_file = ${DIR}/certs/server.pem\n\t\t\tca_file = ${DIR}/certs/ca.pem\n\t\t\trequire_client_cert = yes\n\t\t}\n\t}\n`;
const HOME_TLS = (ca = `${DIR}/certs/ca.pem`) => `\ttls {\n\t\tprivate_key_file = ${DIR}/certs/client.key\n\t\tcertificate_file = ${DIR}/certs/client.pem\n\t\tca_file = ${ca}\n\t}\n`;
const PROXY_CONF = (homeBody = `\tproto = tcp\n${HOME_TLS()}`) => `home_server home1 {\n  ipaddr = 10.0.0.3\n  response_window = 1\n${homeBody}}\nhome_server_pool pool1 {\n  home_server = home1\n}\nrealm example.com {\n  auth_pool = pool1\n  acct_pool = pool1\n}\nrealm LOCAL {\n}\n`;

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
  const authority = CertificateAuthority.generate('CN=Lab CA', { now: NOW });
  const foreign = CertificateAuthority.generate('CN=Foreign CA', { now: NOW });
  install(home, authority, [{ name: 'server', subject: 'CN=home.lab', alt: ['DNS:home.lab'] }]);
  install(edge, options.foreignCa === true ? foreign : authority, [{ name: 'client', subject: 'CN=edge' }]);
  write(edge, `${DIR}/certs/ca.pem`, certToPem((options.foreignCa === true ? foreign : authority).rootCertificate));
  write(home, CLIENTS_CONF_PATH, 'client edge {\n  ipaddr = 10.0.0.2\n  proto = tls\n  secret = radsec\n}\nclient nas {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(home, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  write(home, SITE, (vfsOf(home).readFile(SITE) ?? '').replace('server default {\n', `server default {\n${LISTEN}`));
  write(edge, CLIENTS_CONF_PATH, 'client nas {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(edge, PROXY, proxyConf);
  await home.executeCommand('systemctl restart freeradius');
  const started = await edge.executeCommand('systemctl restart freeradius');
  return { client, edge, home, started, authority };
}

const login = (user: string, password = 'wonderland') => `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -x -r 1 10.0.0.2 auth shared`;
const start = (user: string) => `printf 'User-Name = "${user}"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s1"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 1\\n' | radclient -r 1 10.0.0.2 acct shared`;


const established = async (home: LinuxServer) => (await home.executeCommand('ss -tn state established')).split('\n').filter((line) => line.includes(':2083')).length;

describe('RadSec connection reuse', () => {
  it('witness: a proxied request is answered over RadSec', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });

  it('the connection stays open after the reply, one for any number of requests', async () => {
    const { client, home } = await lab();
    await client.executeCommand(login('alice@example.com'));
    expect(await established(home)).toBe(1);
    await client.executeCommand(login('alice@example.com'));
    await client.executeCommand(login('alice@example.com', 'wrong'));
    expect(await established(home)).toBe(1);
  });

  it('accounting and authentication to the same TLS home server share the connection', async () => {
    const { client, home } = await lab();
    await client.executeCommand(login('alice@example.com'));
    expect(await client.executeCommand(start('alice@example.com'))).toContain('Received Accounting-Response');
    expect(await established(home)).toBe(1);
  });

  it('stopping the proxy closes the connection', async () => {
    const { client, edge, home } = await lab();
    await client.executeCommand(login('alice@example.com'));
    await edge.executeCommand('systemctl stop freeradius');
    expect(await established(home)).toBe(0);
  });

  it('a home server that restarted drops the old connection: the next request reconnects and is answered', async () => {
    const { client, home } = await lab();
    await client.executeCommand(login('alice@example.com'));
    await home.executeCommand('systemctl restart freeradius');
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });
});
