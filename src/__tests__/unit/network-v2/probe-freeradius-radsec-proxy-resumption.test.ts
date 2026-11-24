/*
 * Probe: a RadSec home_server connection that the proxy had to rebuild redid a full handshake: the ticket the home server issued was dropped with
 * the old connection. Source of truth: RFC 8446 2.2 (a client resumes with the ticket of an earlier connection), FreeRADIUS v3.2.x tls.c (the
 * session cache of the home server's tls section is what a reconnecting client resumes against). The service now keeps, per home server and port, the
 * ticket its RadSec connection received, offers it when it reconnects, and replaces it with the one the resumed handshake issues. The home side counts
 * the connections it served as resumptions (radSecResumedConnections), the observable of this probe: there is no -X line for it in the source to match.
 *
 * Discriminated by mutation, since the counter did not exist on the base (every case would fall there for that reason alone): with the single line that offers the stored
 * ticket removed, 2 of 3 cases fall; the witness (the first request is served over a full handshake: nothing resumed) passes either way and is named.
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

const LISTEN = `\tlisten {\n\t\ttype = auth+acct\n\t\tipaddr = *\n\t\tport = 2083\n\t\tproto = tcp\n\t\ttls {\n\t\t\tprivate_key_file = ${DIR}/certs/server.key\n\t\t\tcertificate_file = ${DIR}/certs/server.pem\n\t\t\tca_file = ${DIR}/certs/ca.pem\n\t\t\trequire_client_cert = yes\n\t\t\ttls_min_version = "1.3"\n\t\t\ttls_max_version = "1.3"\n\t\t\tcache {\n\t\t\t\tenable = yes\n\t\t\t}\n\t\t}\n\t}\n`;
const HOME_TLS = (ca = `${DIR}/certs/ca.pem`) => `\ttls {\n\t\tprivate_key_file = ${DIR}/certs/client.key\n\t\tcertificate_file = ${DIR}/certs/client.pem\n\t\tca_file = ${ca}\n\t\ttls_min_version = "1.3"\n\t\ttls_max_version = "1.3"\n\t}\n`;
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


const dropPooled = (edge: LinuxServer) => {
  const pool = (edge.getRadiusd() as unknown as { radSecConnections: Map<string, { close(): void }> }).radSecConnections;
  for (const connection of pool.values()) connection.close();
  pool.clear();
};
const resumedOn = (home: LinuxServer) => (home.getRadiusd() as unknown as { radSecResumedConnections(): number }).radSecResumedConnections();

describe('RadSec proxy connection resumption', () => {
  it('witness: the first request is served over a full handshake, nothing is resumed', async () => {
    const { client, home } = await lab();
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
    expect(resumedOn(home)).toBe(0);
  });

  it('a connection the proxy rebuilds resumes with the ticket of the previous one, and the request is served', async () => {
    const { client, edge, home } = await lab();
    await client.executeCommand(login('alice@example.com'));
    dropPooled(edge);
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
    expect(resumedOn(home)).toBe(1);
  });

  it('each resumed handshake leaves a new ticket: a third connection resumes too', async () => {
    const { client, edge, home } = await lab();
    await client.executeCommand(login('alice@example.com'));
    dropPooled(edge);
    await client.executeCommand(login('alice@example.com'));
    dropPooled(edge);
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
    expect(resumedOn(home)).toBe(2);
  });
});
