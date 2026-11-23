/*
 * Probe: status_check on a home_server that speaks RadSec was refused ("status_check over RadSec is not implemented"), so a TLS home
 * server that came back was only noticed when a user request reached it. Source of truth: FreeRADIUS v3.2.x src/main/process.c
 * (status_check probes go to a zombie home server every check_interval; num_answers_to_alive consecutive answers revive it; an
 * unanswered probe resets the count) and RFC 6613/6614 (Status-Server travels on the TLS stream like any request, RFC 5997). The probe
 * is a real RadSec exchange: handshake, Status-Server with Message-Authenticator signed with the radsec secret, the answer on the stream.
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; the control (without status_check a recovered TLS home server stays
 * zombie until a user request reaches it) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualTimeScheduler, __setDefaultScheduler, getDefaultScheduler } from '@/events/Scheduler';
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

beforeEach(() => { __setDefaultScheduler(new VirtualTimeScheduler()); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

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


const SOCKET = '/var/run/freeradius/freeradius.sock';
const CONTROL = '/etc/freeradius/3.0/sites-enabled/control-socket';
const pass = (seconds: number) => (getDefaultScheduler() as VirtualTimeScheduler).advanceBy(seconds * 1000);
const stateOf = async (edge: LinuxServer) => (await edge.executeCommand(`radmin -f ${SOCKET} -e "show home_server state 10.0.0.3 2083"`)).trim();
const CHECKED = (extra = '') => PROXY_CONF(`\tproto = tcp\n\tstatus_check = status-server\n\tcheck_interval = 6\n\tnum_answers_to_alive = 2\n${extra}${HOME_TLS()}`);

async function outage(proxyConf: string) {
  const made = await lab(proxyConf);
  write(made.edge, CONTROL, 'listen {\n  type = control\n  socket = ${run_dir}/${name}.sock\n  mode = rw\n}\n');
  await made.edge.executeCommand('systemctl restart freeradius');
  await made.home.executeCommand('systemctl stop freeradius');
  await (getDefaultScheduler() as VirtualTimeScheduler).advanceUntilSettled(made.client.executeCommand(login('alice@example.com').replace('-r 1', '-r 1 -t 2')));
  return made;
}

describe('status_check over RadSec', () => {
  it('control: without status_check a recovered TLS home server is not noticed by the clock', async () => {
    const { edge, home } = await outage(PROXY_CONF());
    expect(await stateOf(edge)).toBe('zombie');
    await home.executeCommand('systemctl start freeradius');
    await pass(20);
    expect(await stateOf(edge)).not.toBe('alive');
  });

  it('is accepted in the configuration of a TLS home server', async () => {
    const made = await lab(CHECKED());
    expect(made.started).not.toContain('status_check over RadSec');
    expect(made.started).not.toContain('Failed');
  });

  it('a recovered TLS home server is made alive again by the probes alone', async () => {
    const { edge, home } = await outage(CHECKED());
    expect(await stateOf(edge)).toBe('zombie');
    await home.executeCommand('systemctl start freeradius');
    await pass(20);
    expect(await stateOf(edge)).toBe('alive');
  });

  it('the probes are Status-Server requests that the home server receives over TLS', async () => {
    const { edge, home } = await outage(CHECKED());
    const seen: string[] = [];
    await home.executeCommand('systemctl start freeradius');
    home.followRadiusDebug((line) => seen.push(line));
    await pass(20);
    expect(await stateOf(edge)).toBe('alive');
    expect(seen.filter((line) => /Received Status-Server Id/.test(line)).length).toBeGreaterThanOrEqual(2);
  });
});
