/*
 * Probe - impstats push.* on a simulated Linux host with real frames: the daemon POSTs its counters to a receiver that is another machine on the cable (a
 * TcpStack listener, so a request that reaches the handler crossed the wire), over clear text and over TLS.  The HTTP client is the curl engine of the
 * machine (the one `curl` runs), so the trust store, the --cacert file, the client certificate and -k mean on the daemon what they mean on the command line,
 * and the files are read with the credentials the daemon holds after it dropped privileges.  The Windows equivalent does not exist: rsyslog runs on Linux
 * only, and the Windows emitters (event-log forwarding) share none of this module.
 * Measured before the parameters existed (git stash push -- src/network): 7 of the 8 cases fall - the module refused push.url and nothing reached the receiver.
 * The one that passes either way is the WITNESS (a daemon without push.url sends nothing).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { snappyUncompress } from '@/network/rsyslog/Snappy';
import { decodeWriteRequest, type DecodedSeries } from './_helpers/prometheusWire';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const NOW = Date.now();
const RECEIVER = '192.168.50.2';

interface Received {
  readonly method: string;
  readonly target: string;
  readonly headers: Record<string, string>;
  readonly series: DecodedSeries[];
}

interface Lab {
  readonly server: LinuxServer;
  readonly client: LinuxPC;
  readonly received: Received[];
  status: number;
}

function handlerOf(lab: { received: Received[]; status: number }): (request: HttpMessage) => HttpMessage {
  return (request) => {
    const snappy = snappyUncompress(request.body ?? new Uint8Array(0));
    lab.received.push({
      method: request.method ?? '',
      target: request.target ?? '',
      headers: Object.fromEntries(request.headers.entries().map(([name, value]) => [name.toLowerCase(), value])),
      series: snappy.ok ? decodeWriteRequest(snappy.bytes) : [],
    });
    return createResponse(lab.status, lab.status === 204 ? 'No Content' : 'Status');
  };
}

async function lab(config: string, serve: 'http' | 'https' | 'none' = 'http'): Promise<Lab & { ca: CertificateAuthority }> {
  const server = new LinuxServer('linux-server', 'server1', 0, 0);
  const client = new LinuxPC('linux-pc', 'client1', 0, 0);
  server.powerOn();
  client.powerOn();
  new Cable('wire').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ip addr add 192.168.50.1/24 dev eth0');
  await server.executeCommand('ip link set eth0 up');
  await client.executeCommand('ip addr add 192.168.50.2/24 dev eth0');
  await client.executeCommand('ip link set eth0 up');
  const state = { received: [] as Received[], status: 204 };
  const ca = CertificateAuthority.generate('CN=push-ca', { now: NOW });
  if (serve === 'http') new Http1ServerSession(client.getTcpStack(), 8428, handlerOf(state)).start();
  if (serve === 'https') {
    const issued = ca.issueCertificate({ subject: `CN=${RECEIVER}`, notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: [RECEIVER] });
    new HttpsServerSession(client.getTcpStack(), 8443, { serverCert: issued.cert, serverPrivateKey: issued.privateKey }, handlerOf(state)).start();
  }
  await server.executeCommand(`printf '%s' '${certToPem(ca.rootCertificate)}' > /etc/ssl/push-ca.pem`);
  await server.executeCommand(`printf '${config.replace(/'/g, "'\\''")}\\n' > /etc/rsyslog.d/40-test.conf`);
  await server.executeCommand('systemctl restart rsyslog');
  return { server, client, ca, get received() { return state.received; }, get status() { return state.status; }, set status(value: number) { state.status = value; } };
}

const module = (params: string): string => `module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log" ${params})\n*.* /var/log/probe.log`;

async function pump(target: Lab, seconds = 60): Promise<void> {
  target.server.advanceTime(seconds * 1000);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await target.server.executeCommand('true');
}

const syslogText = (target: Lab): Promise<string> => target.server.executeCommand('cat /var/log/syslog');

describe('impstats push on a Linux host', () => {
  it('witness: a daemon without push.url sends nothing across the wire', async () => {
    const target = await lab(module(''));
    await pump(target, 180);
    expect(target.received).toEqual([]);
  });

  it('posts the counters to a receiver on the cable, with the remote-write headers and the host name as instance', async () => {
    const target = await lab(module(`push.url="http://${RECEIVER}:8428/api/v1/write"`));
    await pump(target);
    expect(target.received).toHaveLength(1);
    const [request] = target.received;
    expect(request.method).toBe('POST');
    expect(request.target).toBe('/api/v1/write');
    expect(request.headers).toMatchObject({ 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy', 'x-prometheus-remote-write-version': '0.1.0', 'user-agent': 'rsyslog-impstats' });
    expect(request.series.length).toBeGreaterThan(10);
    expect(request.series[0].labels.find((label) => label.name === 'instance')?.value).toBe('server1');
  });

  it('reads live counters: the open file count in the pushed series is the one the daemon reports', async () => {
    const target = await lab(module(`push.url="http://${RECEIVER}:8428/api/v1/write"`));
    await pump(target);
    const series = target.received[0].series.find((entry) => entry.labels.some((label) => label.value === 'U__impstats__resource_2D_usage__openfiles__total'));
    expect(series?.value).toBeGreaterThan(0);
  });

  it('reports an unreachable receiver in libcurl\'s words and delivers again once the link is back', async () => {
    const target = await lab(module(`push.url="http://${RECEIVER}:8428/api/v1/write" push.timeout.ms="2000"`));
    await target.server.executeCommand('ip link set eth0 down');
    await pump(target);
    expect(target.received).toEqual([]);
    expect(await syslogText(target)).toMatch(/impstats_push: HTTP request failed: (Couldn't connect to server|Timeout was reached|Network is unreachable)/);
    await target.server.executeCommand('ip link set eth0 up');
    await pump(target);
    expect(target.received).toHaveLength(1);
  });

  it('logs a server error status and keeps pushing at the next interval', async () => {
    const target = await lab(module(`push.url="http://${RECEIVER}:8428/api/v1/write"`));
    target.status = 500;
    await pump(target);
    expect(await syslogText(target)).toContain('impstats_push: HTTP 500 from remote endpoint');
    target.status = 204;
    await pump(target);
    expect(target.received).toHaveLength(2);
  });

  it('pushes over TLS when the CA is given by push.tls.cafile', async () => {
    const target = await lab(module(`push.url="https://${RECEIVER}:8443/api/v1/write" push.tls.cafile="/etc/ssl/push-ca.pem"`), 'https');
    await pump(target);
    expect(target.received).toHaveLength(1);
  });

  it('reads the TLS files with the credentials the daemon dropped to, and disables push when it cannot', async () => {
    const target = await lab(module(`push.url="https://${RECEIVER}:8443/api/v1/write" push.tls.cafile="/etc/ssl/push-ca.pem"`), 'https');
    await target.server.executeCommand('chmod 600 /etc/ssl/push-ca.pem');
    await target.server.executeCommand('useradd -r -s /usr/sbin/nologin syslog');
    await target.server.executeCommand('touch /var/log/probe.log /var/log/stats.log');
    await target.server.executeCommand('chown syslog:syslog /var/log/probe.log /var/log/stats.log /var/log/syslog');
    await target.server.executeCommand(`printf '%s\\n' 'global(privDrop.user.name="syslog")' > /etc/rsyslog.d/10-drop.conf`);
    await target.server.executeCommand('systemctl restart rsyslog');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    target.received.length = 0;
    await pump(target);
    expect(target.received).toEqual([]);
    expect(await syslogText(target)).toContain("impstats: push.tls.cafile '/etc/ssl/push-ca.pem' is not readable: Permission denied");
    expect(await syslogText(target)).toContain('impstats: disabling push due to TLS configuration error');
  });

  it('refuses an untrusted receiver, explains it, and accepts it once verification is switched off', async () => {
    const refused = await lab(module(`push.url="https://${RECEIVER}:8443/api/v1/write"`), 'https');
    await pump(refused);
    expect(refused.received).toEqual([]);
    expect(await syslogText(refused)).toContain(`impstats_push: TLS verification failed for https://${RECEIVER}:8443/api/v1/write. Provide push.tls.cafile`);
    const skipped = await lab(module(`push.url="https://${RECEIVER}:8443/api/v1/write" push.tls.insecureSkipVerify="on"`), 'https');
    await pump(skipped);
    expect(skipped.received).toHaveLength(1);
  });
});
