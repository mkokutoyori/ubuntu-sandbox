/*
 * RFC 5425 transport for the Linux rsyslog daemon: omfwd and imtcp with streamdriver="gtls" and streamdriver.mode="1" run
 * a real TLS handshake over the machine's TcpStack, load the certificates and keys from /etc, and apply the driver's own
 * authentication (anon, x509/fingerprint, x509/certvalid, x509/name with wildcard peers) - ported from nsd_gtls.c.
 * Certificates come from the machine's own openssl command; the expiry case moves the simulated clock with advanceTime().
 * Measured against the previous commit (af7e93fda, replayed in a worktree): the 10 cases fall, TLS modes were refused at load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const PKI = '/etc/pki/lab';
const DRIVER_FILE = '/usr/lib/x86_64-linux-gnu/rsyslog/lmnsd_gtls.so';

interface Lab { sender: LinuxServer; collector: LinuxServer }

function vfsOf(server: LinuxServer): { writeFile(path: string, content: string, uid: number, gid: number, umask: number): boolean; readFile(path: string): string | null } {
  return (server as unknown as { executor: { vfs: ReturnType<typeof vfsOf> } }).executor.vfs;
}

async function pki(collector: LinuxServer, sender: LinuxServer, days = 30): Promise<void> {
  await collector.executeCommand(`mkdir -p ${PKI}`);
  const run = async (command: string): Promise<void> => { await collector.executeCommand(`cd ${PKI} && ${command}`); };
  await run('openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 365 -nodes -subj "/CN=Lab CA" -addext "basicConstraints=critical,CA:TRUE"');
  for (const [name, san] of [['central', 'DNS:central.lab,IP:10.0.0.2'], ['sender', 'DNS:sender.lab,IP:10.0.0.1']] as const) {
    await run(`openssl req -new -newkey rsa:2048 -nodes -keyout ${name}.key -out ${name}.csr -subj "/CN=${name}.lab"`);
    await run(`printf "subjectAltName=${san}\\n" > ${name}.ext`);
    await run(`openssl x509 -req -in ${name}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ${name}.crt -days ${days} -extfile ${name}.ext`);
  }
  await run('openssl req -x509 -newkey rsa:2048 -keyout rogue-ca.key -out rogue-ca.crt -days 365 -nodes -subj "/CN=Rogue CA"');
  const source = vfsOf(collector);
  const target = vfsOf(sender);
  target.writeFile(`${PKI}/ca.crt`, source.readFile(`${PKI}/ca.crt`) ?? '', 0, 0, 0o022);
  target.writeFile(`${PKI}/rogue-ca.crt`, source.readFile(`${PKI}/rogue-ca.crt`) ?? '', 0, 0, 0o022);
  for (const name of ['sender.crt', 'sender.key']) target.writeFile(`${PKI}/${name}`, source.readFile(`${PKI}/${name}`) ?? '', 0, 0, 0o022);
}

function files(server: LinuxServer, driver = true): void {
  if (driver) vfsOf(server).writeFile(DRIVER_FILE, '', 0, 0, 0o022);
}

async function configure(server: LinuxServer, text: string): Promise<void> {
  vfsOf(server).writeFile('/etc/rsyslog.d/60-tls.conf', text, 0, 0, 0o022);
  await server.executeCommand('systemctl restart rsyslog');
}

const GLOBAL = (name: string, extra = ''): string =>
  `global(DefaultNetstreamDriver="gtls" DefaultNetstreamDriverCAFile="${PKI}/ca.crt" DefaultNetstreamDriverCertFile="${PKI}/${name}.crt" DefaultNetstreamDriverKeyFile="${PKI}/${name}.key"${extra})\n`;

const COLLECTOR = (peers: string, auth = 'x509/name', extra = ''): string =>
  `${GLOBAL('central')}module(load="imtcp" StreamDriver.Name="gtls" StreamDriver.Mode="1" StreamDriver.AuthMode="${auth}")\ninput(type="imtcp" port="6514" PermittedPeer=[${peers}]${extra})\n`;

const SENDER = (peers: string, auth = 'x509/name', cert = 'sender', global = GLOBAL(cert)): string =>
  `${global}*.* action(type="omfwd" target="10.0.0.2" port="6514" protocol="tcp" StreamDriver="gtls" StreamDriverMode="1" StreamDriverAuthMode="${auth}" StreamDriverPermittedPeers="${peers}")\n`;

async function lab(options: { days?: number } = {}): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const sender = new LinuxServer('linux-server', 'sender', 0, 0);
  const collector = new LinuxServer('linux-server', 'collector', 0, 0);
  [sender, collector].forEach((server, index) => {
    new Cable(`c${index}`).connect(server.getPorts()[0], sw.getPorts()[index]);
    server.getPorts()[0].configureIP(new IPAddress(`10.0.0.${index + 1}`), new SubnetMask('255.255.255.0'));
  });
  [sender, collector, sw].forEach((device) => device.powerOn());
  files(sender);
  files(collector);
  await pki(collector, sender, options.days);
  return { sender, collector };
}

async function delivered(lab: Lab, marker: string): Promise<boolean> {
  await lab.sender.executeCommand(`logger -t probe ${marker}`);
  return (await lab.collector.executeCommand(`grep -c ${marker} /var/log/syslog`)).trim() !== '0';
}

describe('x509/name, mutual authentication', () => {
  it('delivers over a handshaken connection when both sides name each other', async () => {
    const l = await lab();
    await configure(l.collector, COLLECTOR('"sender.lab"'));
    await configure(l.sender, SENDER('central.lab'));
    expect(await delivered(l, 'tls-ok')).toBe(true);
    expect(await l.collector.executeCommand('grep tls-ok /var/log/syslog')).toContain('sender probe: tls-ok');
  }, 120_000);

  it('accepts a wildcard peer on the collector side', async () => {
    const l = await lab();
    await configure(l.collector, COLLECTOR('"*.lab"'));
    await configure(l.sender, SENDER('*.lab'));
    expect(await delivered(l, 'wildcard-ok')).toBe(true);
  }, 120_000);

  it('the sender refuses a collector whose name is not permitted, and says which names it saw', async () => {
    const l = await lab();
    await configure(l.collector, COLLECTOR('"sender.lab"'));
    await configure(l.sender, SENDER('someone-else.lab'));
    expect(await delivered(l, 'wrong-name')).toBe(false);
    const log = await l.sender.executeCommand('grep "peer name not authorized" /var/log/syslog');
    expect(log).toContain('error: peer name not authorized -  not permitted to talk to it. Names: DNSname: central.lab; IPaddress: 10.0.0.2; CN: central.lab;');
  }, 120_000);

  it('the sender refuses a collector signed by a CA it does not trust', async () => {
    const l = await lab();
    await configure(l.collector, COLLECTOR('"sender.lab"'));
    await configure(l.sender, SENDER('central.lab', 'x509/name', 'sender', GLOBAL('sender').replace('ca.crt', 'rogue-ca.crt')));
    expect(await delivered(l, 'rogue')).toBe(false);
    expect(await l.sender.executeCommand('grep "certificate invalid" /var/log/syslog')).toContain("not permitted to talk to peer '10.0.0.2', certificate invalid: signer not found");
  }, 120_000);

  it('the collector refuses a sender that presents no certificate', async () => {
    const l = await lab();
    await configure(l.collector, COLLECTOR('"sender.lab"'));
    await configure(l.sender, SENDER('central.lab', 'x509/name', 'sender', `global(DefaultNetstreamDriver="gtls" DefaultNetstreamDriverCAFile="${PKI}/ca.crt")\n`));
    expect(await delivered(l, 'no-cert')).toBe(false);
    expect(await l.sender.executeCommand('grep "certificate file is not set" /var/log/syslog')).toContain('warning: certificate file is not set');
    expect(await l.collector.executeCommand('grep "did not provide a certificate" /var/log/syslog')).toContain('not permitted to talk to it');
  }, 120_000);
});

describe('other authentication modes', () => {
  it('anon encrypts without any certificate on either side', async () => {
    const l = await lab();
    await configure(l.collector, `global(DefaultNetstreamDriver="gtls")\nmodule(load="imtcp" StreamDriver.Name="gtls" StreamDriver.Mode="1" StreamDriver.AuthMode="anon")\ninput(type="imtcp" port="6514")\n`);
    await configure(l.sender, `global(DefaultNetstreamDriver="gtls")\n*.* action(type="omfwd" target="10.0.0.2" port="6514" protocol="tcp" StreamDriver="gtls" StreamDriverMode="1" StreamDriverAuthMode="anon")\n`);
    expect(await delivered(l, 'anon-ok')).toBe(true);
  }, 120_000);

  it('x509/fingerprint accepts the pinned SHA256 and refuses another', async () => {
    const l = await lab();
    const printed = await l.collector.executeCommand(`openssl x509 -in ${PKI}/central.crt -noout -fingerprint -sha256`);
    const pinned = `SHA256:${printed.trim().replace(/^.*=/, '')}`;
    await configure(l.collector, COLLECTOR('"sender.lab"'));
    await configure(l.sender, SENDER(pinned, 'x509/fingerprint'));
    expect(await delivered(l, 'pinned')).toBe(true);
    await configure(l.sender, SENDER('SHA256:00:11', 'x509/fingerprint'));
    expect(await delivered(l, 'unpinned')).toBe(false);
    expect(await l.sender.executeCommand('grep "peer fingerprint" /var/log/syslog')).toContain("error: peer fingerprint 'SHA1:");
  }, 120_000);

  it('x509/certvalid ignores names: any certificate from the trusted CA is enough', async () => {
    const l = await lab();
    await configure(l.collector, COLLECTOR('"nobody.lab"', 'x509/certvalid'));
    await configure(l.sender, SENDER('nobody.lab', 'x509/certvalid'));
    expect(await delivered(l, 'certvalid')).toBe(true);
  }, 120_000);
});

describe('time and installation', () => {
  it('an expired collector certificate is refused, tolerated with permitexpiredcerts="on"; the clock is the simulated one', async () => {
    const l = await lab({ days: 1 });
    await configure(l.collector, COLLECTOR('"sender.lab"'));
    await configure(l.sender, SENDER('central.lab'));
    expect(await delivered(l, 'fresh')).toBe(true);
    l.sender.advanceTime(3 * 24 * 3600 * 1000);
    l.collector.advanceTime(3 * 24 * 3600 * 1000);
    await configure(l.sender, SENDER('central.lab'));
    expect(await delivered(l, 'stale')).toBe(false);
    expect(await l.sender.executeCommand('grep "certificate invalid" /var/log/syslog')).toContain('certificate invalid: certificate expired');
    await configure(l.collector, COLLECTOR('"sender.lab"').replace('StreamDriver.Mode="1"', 'StreamDriver.Mode="1" StreamDriver.PermitExpiredCerts="on"'));
    await configure(l.sender, SENDER('central.lab').replace('StreamDriverPermittedPeers', 'StreamDriver.PermitExpiredCerts="on" StreamDriverPermittedPeers'));
    expect(await delivered(l, 'tolerated')).toBe(true);
  }, 180_000);

  it('without the gtls module installed the driver cannot be loaded, whatever the certificates', async () => {
    const l = await lab();
    await l.sender.executeCommand(`rm ${DRIVER_FILE}`);
    await configure(l.sender, SENDER('central.lab'));
    expect(await l.sender.executeCommand('grep "could not load netstream driver" /var/log/syslog')).toContain("could not load netstream driver 'gtls'");
  }, 120_000);
});
