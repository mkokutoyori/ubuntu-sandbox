/*
 * Probe: a realm could not be proxied over RadSec: `proto = tcp` on a home_server was refused, so RADIUS/TLS existed only as a server.
 * Source of truth: RFC 6614 (mutual TLS to port 2083, the secret is the constant "radsec", requests and replies are ordinary RADIUS packets
 * on the TLS stream), FreeRADIUS v3.2.x raddb/proxy.conf and realms.c (home_server { proto = tcp ... tls { private_key_file
 * certificate_file ca_file } }, the home server defaults to port 2083 and is entered once in `show home_server list` with proto tcp: the
 * auth+acct pair on port + 1 is made only for non-TLS servers). The proxy opens a real TLS connection over the cable, presents its own certificate,
 * checks the home server's against ca_file, and relays both Access-Request and Accounting-Request. A handshake that fails counts as a silent
 * home server: no answer to the NAS, zombie state, fail-over to the next server of the pool.
 *
 * Discriminated with git stash on src: 7 of 9 fall before the fix; two pass either way and are named: the witness (the home server
 * listens on 2083) and the foreign-CA silence, vacuous on the base where the proxy is refused; its positive twin, the accept through the
 * same lab with the right CA, is the second case and falls.
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
  write(home, CLIENTS_CONF_PATH, 'client edge {\n  ipaddr = 10.0.0.2\n  secret = radsec\n}\nclient nas {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
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

describe('proxying a realm over RadSec', () => {
  it('witness: the home server answers over its RadSec listener (the edge proxies a plain UDP realm to nobody, so only the lab is checked)', async () => {
    const { home } = await lab();
    expect(await home.executeCommand('ss -ltnp')).toMatch(/:2083\s.*freeradius/);
  });

  it('relays an Access-Request over mutual TLS and returns the home server accept to the NAS', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });

  it('relays a reject for a wrong password', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(login('alice@example.com', 'wrong'))).toContain('Received Access-Reject');
  });

  it('the home server receives the stripped name, from the edge, over the RadSec port', async () => {
    const { client, home } = await lab();
    const seen: string[] = [];
    home.followRadiusDebug((line) => seen.push(line));
    await client.executeCommand(login('alice@example.com'));
    expect(seen.some((line) => line.includes('Received Access-Request') && line.includes('from 10.0.0.2:') && line.includes('to 10.0.0.3:2083'))).toBe(true);
    expect(seen.some((line) => line.includes('User-Name = "alice"'))).toBe(true);
  });

  it('relays an Accounting-Request over RadSec: the home server records the session under the stripped name', async () => {
    const { client, home, edge } = await lab();
    expect(await client.executeCommand(start('alice@example.com'))).toContain('Received Accounting-Response');
    expect(await home.executeCommand('radwho')).toContain('alice');
    expect(await edge.executeCommand('radwho')).not.toContain('alice');
  });

  it('a home server whose certificate is not signed by ca_file is silent: the NAS gets no answer', async () => {
    const { client } = await lab(PROXY_CONF(), { foreignCa: true });
    expect(await client.executeCommand(login('alice@example.com'))).toContain('No reply from server');
  });

  it('radmin lists a TLS home server once, with proto tcp', async () => {
    const made = await lab();
    write(made.edge, '/etc/freeradius/3.0/sites-enabled/control-socket', 'listen {\n  type = control\n  socket = ${run_dir}/${name}.sock\n}\n');
    await made.edge.executeCommand('systemctl restart freeradius');
    expect((await made.edge.executeCommand('radmin -f /var/run/freeradius/freeradius.sock -e "show home_server list"')).trim()).toBe('10.0.0.3\t2083\ttcp\tauth+acct\tunknown\t0');
  });

  it('refuses proto = tcp without a tls section, naming the missing piece', async () => {
    const { started } = await lab(PROXY_CONF('\tproto = tcp\n'));
    expect(started).toContain('proto = tcp without a tls section');
  });

  it('refuses a secret other than radsec, a missing file and an unsupported tls key', async () => {
    expect((await lab(PROXY_CONF(`\tproto = tcp\n\tsecret = other\n${HOME_TLS()}`))).started).toContain('must be "radsec"');
    expect((await lab(PROXY_CONF(`\tproto = tcp\n${HOME_TLS(`${DIR}/certs/absent.pem`)}`))).started).toContain('Failed reading ca_file');
    expect((await lab(PROXY_CONF(`\tproto = tcp\n${HOME_TLS().replace('\t}\n', '\t\tcheck_crl = yes\n\t}\n')}`))).started).toContain('The tls setting "check_crl" is not implemented');
  });
});
