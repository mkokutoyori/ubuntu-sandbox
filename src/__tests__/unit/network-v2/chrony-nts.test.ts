/**
 * Network Time Security (RFC 8915) between two Linux machines: the NTS-KE
 * handshake (TCP 4460, TLS 1.3, ALPN ntske/1), the cookies, and the
 * authenticated NTP packets all cross the cable as real frames. The codecs
 * are compared with the real chronyd 4.5 in nts-oracle.test.ts; here the
 * daemon decides: `nts` on a source, `ntsservercert`/`ntsserverkey` on the
 * server, trust from the system store or `ntstrustedcerts`.
 *
 * Measured against the previous tree (git worktree of HEAD, this file plus
 * the extended nts-oracle.test.ts): 12 of the 25 cases fall, 13 pass. The
 * 13 that pass either way: the 2 witnesses of this file (plain NTP still
 * works against the same server; without the directives nothing listens on
 * 4460) and 11 cases of nts-oracle.test.ts that pin the real chronyd's
 * bytes and need no daemon (structural). The 12 that fall are 3 server-key
 * file cases and 9 labs; the ntstrustedcerts lab asserts the authdata NTS
 * row as well, because the plain-NTP fallback synchronises without it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, privateKeyToPem } from '@/network/pki/pem';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';
import { simulationNowMs } from '@/network/core/SystemClock';

let clock: VirtualTimeScheduler;
let serial = 0;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Lab {
  server: LinuxPC;
  client: LinuxPC;
  ca: CertificateAuthority;
}

function install(pc: LinuxPC, path: string, content: string): void {
  const machine = pc as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): boolean } } };
  machine.executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

async function lab(serverConf: string, clientConf: string, trust = true): Promise<Lab> {
  const tag = ++serial;
  const server = new LinuxPC(`S${tag}`);
  const client = new LinuxPC(`C${tag}`);
  new Cable(`n${tag}`).connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ip addr add 10.0.1.1/24 dev eth0');
  await client.executeCommand('ip addr add 10.0.1.2/24 dev eth0');
  const now = simulationNowMs();
  const ca = CertificateAuthority.generate('CN=ntp-lab-ca', { now: now - 1000 });
  const issued = ca.issueCertificate({
    subject: 'CN=10.0.1.1', notBefore: now - 1000, notAfter: now + 3e11, subjectAltNames: ['10.0.1.1'],
  });
  install(server, '/etc/chrony/nts.crt', certToPem(issued.cert));
  install(server, '/etc/chrony/nts.key', privateKeyToPem(issued.privateKey));
  if (trust) client.addTrustedCertificateAuthority(ca.rootCertificate);
  install(server, '/etc/chrony/chrony.conf', serverConf);
  install(client, '/etc/chrony/chrony.conf', clientConf);
  await server.executeCommand('sudo systemctl restart chrony');
  await client.executeCommand('sudo systemctl restart chrony');
  converge(clock, 120_000);
  return { server, client, ca };
}

const SERVER = 'local stratum 5\nallow\nntsservercert /etc/chrony/nts.crt\nntsserverkey /etc/chrony/nts.key\n';
const CLIENT = 'server 10.0.1.1 iburst nts minpoll 4 maxpoll 4\nmakestep 1000 3\n';

describe('chronyd as an NTS client and server', () => {
  it('witness: the same server answers plain NTP and the client synchronises without nts', async () => {
    const { client } = await lab(SERVER, 'server 10.0.1.1 iburst minpoll 4 maxpoll 4\nmakestep 1000 3\n');
    expect(await client.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.1\.1/);
  });

  it('witness: without the server directives nothing listens on 4460', async () => {
    const { server } = await lab('local stratum 5\nallow\n', CLIENT);
    expect(await server.executeCommand('ss -ltn')).not.toMatch(/:4460\b/);
  });

  it('[fails before] the server opens the NTS-KE port only when a certificate and a key are given', async () => {
    const { server } = await lab(SERVER, CLIENT);
    expect(await server.executeCommand('sudo ss -ltnp')).toMatch(/:4460\b.*chronyd/);
  });

  it('[fails before] the client performs one NTS-KE and synchronises with authenticated packets', async () => {
    const { server, client } = await lab(SERVER, CLIENT);
    expect(await client.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.1\.1/);
    const authdata = await client.executeCommand('sudo chronyc authdata');
    expect(authdata).toMatch(/10\.0\.1\.1\s+NTS\s+1\s+15\s+256\s+\d+\s+0\s+0\s+8\s+96/);
    expect(await server.executeCommand('sudo chronyc serverstats')).toMatch(/NTS-KE connections accepted: 1/);
    expect(server.getNtpAgent().getCounters().serverAuthenticated).toBeGreaterThan(0);
  });

  it('[fails before] the cookie pool is refilled by every response: a client never runs dry', async () => {
    const { client } = await lab(SERVER, CLIENT);
    converge(clock, 300_000);
    expect(await client.executeCommand('sudo chronyc authdata')).toMatch(/NTS\s+1\s+15\s+256\s+\d+\s+0\s+0\s+8\s+96/);
  });

  it('[fails before] a certificate the client does not trust stops the exchange: no cookie, no NTP packet, retry delayed', async () => {
    const { server, client } = await lab(SERVER, CLIENT, false);
    const authdata = await client.executeCommand('sudo chronyc authdata');
    expect(authdata).toMatch(/10\.0\.1\.1\s+NTS\s+0\s+0\s+0\s+-\s+1\s+0\s+0\s+0/);
    expect(await client.executeCommand('chronyc sources')).not.toMatch(/\^\* 10\.0\.1\.1/);
    expect(server.getNtpAgent().getCounters().received).toBe(0);
  });

  it('[fails before] ntstrustedcerts adds the authority to the set the source selects with certset', async () => {
    const { client, ca } = await lab(SERVER, CLIENT, false);
    install(client, '/etc/chrony/ca.pem', certToPem(ca.rootCertificate));
    install(client, '/etc/chrony/chrony.conf', `ntstrustedcerts /etc/chrony/ca.pem\n${CLIENT}`);
    await client.executeCommand('sudo systemctl restart chrony');
    converge(clock, 300_000);
    expect(await client.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.1\.1/);
    expect(await client.executeCommand('sudo chronyc authdata')).toMatch(/10\.0\.1\.1\s+NTS\s+1\s+15\s+256\s+\d+\s+0\s+0\s+8\s+96/);
  });

  it('[fails before] a source naming another certset does not see the authority of set 0', async () => {
    const { client, ca } = await lab(SERVER, CLIENT, false);
    install(client, '/etc/chrony/ca.pem', certToPem(ca.rootCertificate));
    install(client, '/etc/chrony/chrony.conf',
      `ntstrustedcerts /etc/chrony/ca.pem\nserver 10.0.1.1 iburst nts certset 1 minpoll 4 maxpoll 4\nmakestep 1000 3\n`);
    await client.executeCommand('sudo systemctl restart chrony');
    converge(clock, 300_000);
    expect(await client.executeCommand('chronyc sources')).not.toMatch(/\^\* 10\.0\.1\.1/);
  });

  it('[fails before] a key rotation the cookies do not survive makes the server answer NTS NAK and the client run a new NTS-KE', async () => {
    const { server, client } = await lab(`${SERVER}ntsrotate 3600\n`, `${CLIENT}ntsrefresh 7200\n`);
    const before = await server.executeCommand('sudo chronyc serverstats');
    expect(before).toMatch(/NTS-KE connections accepted: 1/);
    clock.advance(4 * 3600 * 1000 + 1000);
    converge(clock, 600_000);
    expect(await client.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.1\.1/);
    expect(await server.executeCommand('sudo chronyc serverstats')).toMatch(/NTS-KE connections accepted: [2-9]/);
  });

  it('[fails before] ntsdumpdir keeps the server keys and the client cookies across a restart', async () => {
    const { server, client } = await lab(`${SERVER}ntsdumpdir /var/lib/chrony\n`, `${CLIENT}ntsdumpdir /var/lib/chrony\n`);
    await client.executeCommand('sudo chronyc dump');
    expect(await server.executeCommand('sudo cat /var/lib/chrony/ntskeys')).toMatch(/^NKS1\n[\d.]+\n([0-9A-F]{8} [0-9A-F]{64} 15\n?){4}$/);
    expect(await client.executeCommand('sudo cat /var/lib/chrony/10.0.1.1.nts')).toMatch(/^NNC0\n10\.0\.1\.1\n/);
    await client.executeCommand('sudo systemctl restart chrony');
    converge(clock, 60_000);
    const accepted = await server.executeCommand('sudo chronyc serverstats');
    expect(accepted).toMatch(/NTS-KE connections accepted: 1/);
  });

  it('[fails before] clients -k lists the NTS-KE request of the client', async () => {
    const { server } = await lab(SERVER, CLIENT);
    expect(await server.executeCommand('sudo chronyc clients -k')).toMatch(/10\.0\.1\.2\s+\d+\s+\d+\s+\S+\s+\S+\s+\S+\s+1\s+0/);
  });
});
