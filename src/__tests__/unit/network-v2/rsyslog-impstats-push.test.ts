/*
 * Probe - the push.* parameters of impstats (plugins/impstats/impstats.c, impstats_push.c, prometheus_remote_write.c of rsyslog 8.2610, built with
 * --enable-impstats-push): each interval the module reads every counter of every statistics object (statsobj.GetAllCounters, no reset), turns it into one
 * Prometheus time series named origin_object_counter_total (encoded by EncodePrometheusMetricName), labels it, sorts the labels, packs the WriteRequest
 * as protobuf (proto3: zero scalars and empty strings are not emitted), compresses it with Snappy and POSTs it with the three remote-write headers.
 * The lab replaces the HTTP port, so every request is read back by an independent protobuf and Snappy decoder.
 * Measured before the parameters existed (git stash push -- src/network): 26 of the 28 cases fall - the module refused every push.* parameter and never
 * sent anything.  The 2 that pass either way are the WITNESS (no request without push.url while the statistics still reach the log file) and the
 * non-regression that the log file keeps receiving the statistics when push is on.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RS_RET } from '@/network/rsyslog/engine/Log';
import type { HttpPostRequest } from '@/network/rsyslog/engine/Host';
import { snappyUncompress } from '@/network/rsyslog/Snappy';
import { LabHost, LabNetwork, startRsyslog, lines } from './_helpers/rsyslogLab';
import { decodeWriteRequest, type DecodedSeries } from './_helpers/prometheusWire';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const URL = 'http://192.168.9.9:8428/api/v1/write';

interface Rig {
  host: LabHost;
  lab: ReturnType<typeof startRsyslog>;
}

function rig(moduleParams: string, files: Record<string, string> = {}): Rig {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  const lab = startRsyslog(host, `module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log" ${moduleParams})\n*.* /var/log/x.log\n`, { files });
  return { host, lab };
}

const diagnostics = (r: Rig): string => `${r.lab.loader.log.lines().join('\n')}\n${r.lab.internalMessages.map((entry) => `${entry.code}:${entry.text}`).join('\n')}`;

async function tick(r: Rig, seconds = 60): Promise<void> {
  r.host.advance(seconds * 1000);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function decoded(request: HttpPostRequest): DecodedSeries[] {
  const result = snappyUncompress(request.body);
  if (!result.ok) throw new Error('the body is not a snappy stream');
  return decodeWriteRequest(result.bytes);
}

const labelsOf = (series: DecodedSeries): Record<string, string> => Object.fromEntries(series.labels.map((label) => [label.name, label.value]));
const named = (series: DecodedSeries[], name: string): DecodedSeries | undefined => series.find((entry) => labelsOf(entry).__name__ === name);

describe('impstats push', () => {
  it('witness: without push.url nothing is sent however long the daemon runs', async () => {
    const r = rig('');
    await tick(r, 600);
    expect(r.host.httpRequests).toEqual([]);
    expect(lines(r.host.fileSystem.get('/var/log/stats.log') ?? null).length).toBeGreaterThan(0);
  });

  it('posts one remote-write request per interval, with the three headers, the user agent and the default timeout', async () => {
    const r = rig(`push.url="${URL}"`);
    await tick(r);
    expect(r.host.httpRequests).toHaveLength(1);
    const request = r.host.httpRequests[0];
    expect(request.url).toBe(URL);
    expect(request.headers).toEqual(['Content-Type: application/x-protobuf', 'Content-Encoding: snappy', 'X-Prometheus-Remote-Write-Version: 0.1.0']);
    expect(request.userAgent).toBe('rsyslog-impstats');
    expect(request.timeoutMs).toBe(5000);
    await tick(r);
    expect(r.host.httpRequests).toHaveLength(2);
  });

  it('turns every counter into a series named origin_object_counter_total, encoded as Prometheus asks', async () => {
    const r = rig(`push.url="${URL}"`);
    await tick(r);
    const series = decoded(r.host.httpRequests[0]);
    expect(named(series, 'U__impstats__resource_2D_usage__openfiles__total')).toBeDefined();
    expect(named(series, 'U__impstats__resource_2D_usage__utime__total')).toBeDefined();
    expect(series.every((entry) => labelsOf(entry).__name__.endsWith('_total'))).toBe(true);
  });

  it('labels each series with instance and job by default, sorted by name with __name__ first', async () => {
    const r = rig(`push.url="${URL}"`);
    await tick(r);
    const [first] = decoded(r.host.httpRequests[0]);
    expect(first.labels.map((label) => label.name)).toEqual(['__name__', 'instance', 'job']);
    expect(labelsOf(first)).toMatchObject({ instance: 'ubuntu', job: 'rsyslog' });
  });

  it('adds push.labels, lets them replace the default instance and job, and sorts every label', async () => {
    const r = rig(`push.url="${URL}" push.labels=["zone=eu","env=prod","job=custom","instance=box-7","novalue","empty="]`);
    await tick(r);
    const [first] = decoded(r.host.httpRequests[0]);
    expect(first.labels.map((label) => label.name)).toEqual(['__name__', 'empty', 'env', 'instance', 'job', 'zone']);
    expect(labelsOf(first)).toMatchObject({ job: 'custom', instance: 'box-7', env: 'prod', zone: 'eu', empty: '' });
  });

  it('switches the default labels with push.label.instance, push.label.job, push.label.origin and push.label.name', async () => {
    const r = rig(`push.url="${URL}" push.label.instance="off" push.label.job="edge" push.label.origin="on" push.label.name="on"`);
    await tick(r);
    const series = decoded(r.host.httpRequests[0]);
    const resource = named(series, 'U__impstats__resource_2D_usage__utime__total') as DecodedSeries;
    expect(labelsOf(resource)).toEqual({ __name__: 'U__impstats__resource_2D_usage__utime__total', job: 'edge', name: 'resource-usage', origin: 'impstats' });
  });

  it('omits the job label when push.label.job is empty', async () => {
    const r = rig(`push.url="${URL}" push.label.job=""`);
    await tick(r);
    const [first] = decoded(r.host.httpRequests[0]);
    expect(first.labels.map((label) => label.name)).toEqual(['__name__', 'instance']);
  });

  it('stamps every sample with the simulated wall clock in milliseconds', async () => {
    const r = rig(`push.url="${URL}"`);
    await tick(r);
    const stamps = new Set(decoded(r.host.httpRequests[0]).map((entry) => entry.timestampMs));
    expect(stamps.size).toBe(1);
    expect([...stamps][0]).toBe(r.host.clock.wallMs());
  });

  it('sends the value the counters have, and omits a zero value as protobuf does', async () => {
    const r = rig(`push.url="${URL}"`);
    await tick(r);
    const series = decoded(r.host.httpRequests[0]);
    const openfiles = named(series, 'U__impstats__resource_2D_usage__openfiles__total') as DecodedSeries;
    expect(openfiles.value).toBe(0);
    expect(openfiles.valueOnWire).toBe(false);
    expect(series.every((entry) => entry.timestampOnWire)).toBe(true);
  });

  it('does not reset the counters it reads, even with resetcounters on', async () => {
    const r = rig(`push.url="${URL}" resetcounters="on"`);
    await tick(r);
    expect(r.host.httpRequests).toHaveLength(1);
  });

  it('keeps writing the statistics to the log file when push is on', async () => {
    const r = rig(`push.url="${URL}"`);
    await tick(r);
    expect(lines(r.host.fileSystem.get('/var/log/stats.log') ?? null).some((line) => line.includes('resource-usage: origin=impstats'))).toBe(true);
  });

  it('splits the series into requests of push.batch.maxSeries', async () => {
    const whole = rig(`push.url="${URL}"`);
    await tick(whole);
    const total = decoded(whole.host.httpRequests[0]).length;
    const r = rig(`push.url="${URL}" push.batch.maxSeries="7"`);
    await tick(r);
    const sizes = r.host.httpRequests.map((request) => decoded(request).length);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(total);
    expect(sizes.slice(0, -1).every((size) => size === 7)).toBe(true);
    expect(sizes.length).toBe(Math.ceil(total / 7));
  });

  it('estimates the series per request from push.batch.maxBytes', async () => {
    const whole = rig(`push.url="${URL}"`);
    await tick(whole);
    const total = decoded(whole.host.httpRequests[0]);
    const r = rig(`push.url="${URL}" push.batch.maxBytes="400"`);
    await tick(r);
    expect(r.host.httpRequests.length).toBeGreaterThan(1);
    expect(r.host.httpRequests.reduce((sum, request) => sum + decoded(request).length, 0)).toBe(total.length);
  });

  it('takes the smaller of push.batch.maxSeries and the estimate from push.batch.maxBytes', async () => {
    const r = rig(`push.url="${URL}" push.batch.maxBytes="100000" push.batch.maxSeries="5"`);
    await tick(r);
    expect(decoded(r.host.httpRequests[0]).length).toBe(5);
  });

  it('sends one request when neither batch parameter is set or both are zero', async () => {
    const r = rig(`push.url="${URL}" push.batch.maxBytes="0" push.batch.maxSeries="0"`);
    await tick(r);
    expect(r.host.httpRequests).toHaveLength(1);
  });

  it('logs a 5xx as retryable (RS_RET_SUSPENDED), a 4xx as an error, and tries again at the next interval', async () => {
    const r = rig(`push.url="${URL}"`);
    r.host.httpOutcome = () => ({ status: 503 });
    await tick(r);
    expect(diagnostics(r)).toContain(`${RS_RET.ERR}:impstats_push: HTTP 503 from remote endpoint`);
    expect(diagnostics(r)).toContain(`${RS_RET.SUSPENDED}:impstats: push to remote endpoint failed (will retry next interval)`);
    r.host.httpOutcome = () => ({ status: 404 });
    await tick(r);
    expect(diagnostics(r)).toContain(`${RS_RET.ERR}:impstats: push to remote endpoint failed (will retry next interval)`);
    expect(r.host.httpRequests).toHaveLength(2);
  });

  it('accepts every 2xx and refuses 1xx and 3xx', async () => {
    const accepted = rig(`push.url="${URL}"`);
    accepted.host.httpOutcome = () => ({ status: 200 });
    await tick(accepted);
    expect(diagnostics(accepted)).not.toContain('HTTP 200');
    const redirected = rig(`push.url="${URL}"`);
    redirected.host.httpOutcome = () => ({ status: 302 });
    await tick(redirected);
    expect(diagnostics(redirected)).toContain('impstats_push: HTTP 302 from remote endpoint');
  });

  it('words a transport failure with libcurl\'s own text and marks it retryable', async () => {
    const r = rig(`push.url="${URL}"`);
    r.host.httpOutcome = () => ({ curlCode: 7 });
    await tick(r);
    expect(diagnostics(r)).toContain(`${RS_RET.ERR}:impstats_push: HTTP request failed: Couldn't connect to server`);
    expect(diagnostics(r)).toContain(`${RS_RET.SUSPENDED}:impstats: push to remote endpoint failed (will retry next interval)`);
  });

  it('explains the TLS failures before the generic transport line', async () => {
    const verification = rig(`push.url="https://metrics.example/api/v1/write"`);
    verification.host.httpOutcome = () => ({ curlCode: 60 });
    await tick(verification);
    expect(diagnostics(verification)).toContain('impstats_push: TLS verification failed for https://metrics.example/api/v1/write. Provide push.tls.cafile or set push.tls.insecureSkipVerify="on" for testing');
    expect(diagnostics(verification)).toContain('impstats_push: HTTP request failed: SSL peer certificate or SSH remote key was not OK');
    const certificate = rig(`push.url="https://metrics.example/w"`);
    certificate.host.httpOutcome = () => ({ curlCode: 58 });
    await tick(certificate);
    expect(diagnostics(certificate)).toContain('impstats_push: TLS client cert problem for https://metrics.example/w. Check push.tls.certfile and push.tls.keyfile');
    const connection = rig(`push.url="https://metrics.example/w"`);
    connection.host.httpOutcome = () => ({ curlCode: 35 });
    await tick(connection);
    expect(diagnostics(connection)).toContain('impstats_push: TLS connection error for https://metrics.example/w');
  });

  it('stops at the first failing batch and sends the others at the next interval only', async () => {
    const r = rig(`push.url="${URL}" push.batch.maxSeries="5"`);
    let answered = 0;
    r.host.httpOutcome = () => ({ status: ++answered === 2 ? 500 : 204 });
    await tick(r);
    expect(r.host.httpRequests).toHaveLength(2);
  });

  it('sends the requests of successive intervals one after the other', async () => {
    const r = rig(`push.url="${URL}"`);
    const release: Array<() => void> = [];
    r.host.httpOutcome = () => new Promise((resolve) => { release.push(() => resolve({ status: 204 })); });
    await tick(r);
    await tick(r);
    expect(r.host.httpRequests).toHaveLength(1);
    release[0]();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(r.host.httpRequests).toHaveLength(2);
  });

  it('pushes the final counters when the daemon stops', async () => {
    const r = rig(`push.url="${URL}"`);
    r.lab.engine.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(r.host.httpRequests).toHaveLength(1);
  });

  it('reports a request timeout of push.timeout.ms', async () => {
    const r = rig(`push.url="${URL}" push.timeout.ms="1500"`);
    await tick(r);
    expect(r.host.httpRequests[0].timeoutMs).toBe(1500);
  });
});

describe('impstats push TLS parameters', () => {
  const CA = '/etc/ssl/push-ca.pem';
  const CERT = '/etc/ssl/push-cert.pem';
  const KEY = '/etc/ssl/push-key.pem';
  const FILES = { [CA]: 'ca', [CERT]: 'cert', [KEY]: 'key' };
  const HTTPS = 'https://metrics.example/api/v1/write';

  it('hands the CA, the client certificate and the key to the request', async () => {
    const r = rig(`push.url="${HTTPS}" push.tls.cafile="${CA}" push.tls.certfile="${CERT}" push.tls.keyfile="${KEY}"`, FILES);
    await tick(r);
    expect(r.host.httpRequests[0].tls).toEqual({ caFile: CA, certFile: CERT, keyFile: KEY, insecure: false });
  });

  it('warns that push.tls.* is ignored for a clear-text URL and still pushes', async () => {
    const r = rig(`push.url="${URL}" push.tls.cafile="${CA}"`, FILES);
    await tick(r);
    expect(diagnostics(r)).toContain('impstats: push.tls.* configured but push.url is not https; TLS options will be ignored');
    expect(r.host.httpRequests).toHaveLength(1);
  });

  it('disables push when the certificate is given without its key, or the key without its certificate', async () => {
    const certificate = rig(`push.url="${HTTPS}" push.tls.certfile="${CERT}"`, FILES);
    await tick(certificate);
    expect(diagnostics(certificate)).toContain('impstats: push.tls.certfile is set but push.tls.keyfile is missing');
    expect(diagnostics(certificate)).toContain('impstats: disabling push due to TLS configuration error');
    expect(certificate.host.httpRequests).toEqual([]);
    const key = rig(`push.url="${HTTPS}" push.tls.keyfile="${KEY}"`, FILES);
    await tick(key);
    expect(diagnostics(key)).toContain('impstats: push.tls.keyfile is set but push.tls.certfile is missing');
    expect(key.host.httpRequests).toEqual([]);
  });

  it('disables push when a TLS file is not readable, naming the file and the errno', async () => {
    const r = rig(`push.url="${HTTPS}" push.tls.cafile="/etc/ssl/missing.pem"`, FILES);
    await tick(r);
    expect(diagnostics(r)).toContain("impstats: push.tls.cafile '/etc/ssl/missing.pem' is not readable: No such file or directory");
    expect(r.host.httpRequests).toEqual([]);
  });

  it('warns when verification is switched off for an https URL', async () => {
    const r = rig(`push.url="${HTTPS}" push.tls.insecureSkipVerify="on"`);
    await tick(r);
    expect(diagnostics(r)).toContain(`impstats: TLS verification disabled for push.url '${HTTPS}' (testing only)`);
    expect(r.host.httpRequests[0].tls.insecure).toBe(true);
  });
});
