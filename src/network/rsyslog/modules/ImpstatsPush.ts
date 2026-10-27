import { curlStrerror } from '@/network/http/curl/CurlStrerror';
import type { HttpPostOutcome, RsyslogHost } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type { ModuleContext } from '../engine/Modules';
import { prometheusMetricName, type Statistics } from '../engine/Statistics';
import { buildSeries, encodeWriteRequest, packedWriteRequestSize, type WriteSeries } from '../PrometheusRemoteWrite';
import type { ParamDescriptor } from '../config/Params';

const CURLE_PEER_FAILED_VERIFICATION = 60;
const CURLE_SSL_CACERT_BADFILE = 77;
const CURLE_SSL_CERTPROBLEM = 58;
const CURLE_SSL_CONNECT_ERROR = 35;
const CURLE_SSL_ENGINE_NOTFOUND = 53;
const CURLE_SSL_ENGINE_SETFAILED = 54;
const HTTP_SERVER_ERROR = 500;
const RS_RET_OK = 0;
const USER_AGENT = 'rsyslog-impstats';

export const PUSH_PARAMS: readonly ParamDescriptor[] = [
  { name: 'push.url', type: 'word' }, { name: 'push.labels', type: 'array' }, { name: 'push.timeout.ms', type: 'int' },
  { name: 'push.label.instance', type: 'binary' }, { name: 'push.label.origin', type: 'binary' }, { name: 'push.label.name', type: 'binary' },
  { name: 'push.label.job', type: 'word' }, { name: 'push.tls.cafile', type: 'word' }, { name: 'push.tls.certfile', type: 'word' },
  { name: 'push.tls.keyfile', type: 'word' }, { name: 'push.tls.insecureSkipVerify', type: 'binary' },
  { name: 'push.batch.maxBytes', type: 'int' }, { name: 'push.batch.maxSeries', type: 'int' },
];

export interface PushConfig {
  url: string | null;
  labels: string[];
  timeoutMs: number;
  labelInstance: boolean;
  labelOrigin: boolean;
  labelName: boolean;
  labelJob: string;
  tlsCaFile: string | null;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  tlsInsecureSkipVerify: boolean;
  batchMaxBytes: number;
  batchMaxSeries: number;
}

export function defaultPushConfig(): PushConfig {
  return {
    url: null, labels: [], timeoutMs: 5000, labelInstance: true, labelOrigin: false, labelName: false, labelJob: 'rsyslog',
    tlsCaFile: null, tlsCertFile: null, tlsKeyFile: null, tlsInsecureSkipVerify: false, batchMaxBytes: 0, batchMaxSeries: 0,
  };
}

function labelKeyExists(labels: readonly string[], key: string): boolean {
  return labels.some((label) => {
    const separator = label.indexOf('=');
    return separator === key.length && label.startsWith(key);
  });
}

function metricNameOf(origin: string, name: string, counter: string): string {
  const raw = name !== '' ? `${origin}_${name}_${counter}_total` : `${origin}_${counter}_total`;
  return prometheusMetricName(raw);
}

function unsignedValue(value: number): number {
  return Number(BigInt.asUintN(64, BigInt(Math.trunc(value))));
}

export function validatePushTls(config: PushConfig, context: ModuleContext): boolean {
  const { host, runtime } = context;
  const url = config.url ?? '';
  const usesTls = url.slice(0, 8).toLowerCase() === 'https://';
  const hasTlsOptions = config.tlsCaFile !== null || config.tlsCertFile !== null || config.tlsKeyFile !== null || config.tlsInsecureSkipVerify;
  if (hasTlsOptions && !usesTls) {
    runtime.error('impstats: push.tls.* configured but push.url is not https; TLS options will be ignored', RS_RET.NO_ERRCODE);
    return true;
  }
  if (config.tlsCertFile !== null && config.tlsKeyFile === null) {
    runtime.error('impstats: push.tls.certfile is set but push.tls.keyfile is missing', RS_RET.PARAM_ERROR);
    return false;
  }
  if (config.tlsKeyFile !== null && config.tlsCertFile === null) {
    runtime.error('impstats: push.tls.keyfile is set but push.tls.certfile is missing', RS_RET.PARAM_ERROR);
    return false;
  }
  for (const [label, path] of [['cafile', config.tlsCaFile], ['certfile', config.tlsCertFile], ['keyfile', config.tlsKeyFile]] as const) {
    if (path === null) continue;
    const opened = host.files.openRead(path);
    if ('error' in opened) {
      runtime.error(`impstats: push.tls.${label} '${path}' is not readable`, RS_RET.PARAM_ERROR, opened.missing ? 'ENOENT' : 'EACCES');
      return false;
    }
    opened.file.close();
  }
  if (usesTls && config.tlsInsecureSkipVerify) runtime.error(`impstats: TLS verification disabled for push.url '${url}' (testing only)`, RS_RET.NO_ERRCODE);
  return true;
}

export class StatisticsPusher {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: PushConfig,
    private readonly instance: string,
    private readonly host: RsyslogHost,
    private readonly context: ModuleContext,
  ) {}

  push(statistics: Statistics): void {
    const collected = this.collect(statistics);
    if (collected === null) return;
    this.queue = this.queue.then(() => this.send(collected));
  }

  private collect(statistics: Statistics): WriteSeries[] | null {
    const config = this.config;
    const series: WriteSeries[] = [];
    const timestampMs = Math.floor(this.host.clock.wallMs());
    let failed = false;
    statistics.forEachCounter((object, counter, value) => {
      if (failed) return;
      if (object.origin === null) {
        failed = true;
        return;
      }
      const labels = [...config.labels];
      if (config.labelInstance && this.instance !== '' && !labelKeyExists(labels, 'instance')) labels.push(`instance=${this.instance}`);
      if (config.labelJob !== '' && !labelKeyExists(labels, 'job')) labels.push(`job=${config.labelJob}`);
      if (config.labelOrigin && object.origin !== '' && !labelKeyExists(labels, 'origin')) labels.push(`origin=${object.origin}`);
      if (config.labelName && object.name !== '' && !labelKeyExists(labels, 'name')) labels.push(`name=${object.name}`);
      series.push(buildSeries(metricNameOf(object.origin, object.name, counter), unsignedValue(value), timestampMs, labels));
    });
    if (!failed) return series;
    this.context.runtime.error('impstats_push: failed to collect stats', RS_RET.PARAM_ERROR);
    this.context.runtime.error('impstats: push to remote endpoint failed (will retry next interval)', RS_RET.PARAM_ERROR);
    return null;
  }

  private batchSeriesLimit(series: readonly WriteSeries[]): number {
    const config = this.config;
    let limit = config.batchMaxSeries;
    if (config.batchMaxBytes > 0 && series.length > 0) {
      const packed = packedWriteRequestSize(series);
      if (packed > config.batchMaxBytes) {
        const estimate = Math.max(1, Math.floor((config.batchMaxBytes * series.length) / packed));
        if (limit === 0 || estimate < limit) limit = estimate;
      }
    }
    return limit;
  }

  private async send(series: WriteSeries[]): Promise<void> {
    const limit = this.batchSeriesLimit(series);
    const batched = (this.config.batchMaxBytes > 0 || this.config.batchMaxSeries > 0) && limit > 0;
    const batches: WriteSeries[][] = [];
    if (!batched) batches.push(series);
    else for (let start = 0; start < series.length; start += limit) batches.push(series.slice(start, start + limit));
    for (const batch of batches) {
      const code = await this.sendRequest(batch);
      if (code === RS_RET_OK) continue;
      this.context.runtime.error('impstats: push to remote endpoint failed (will retry next interval)', code);
      return;
    }
  }

  private async sendRequest(series: readonly WriteSeries[]): Promise<number> {
    const config = this.config;
    const http = this.host.http;
    if (http === undefined || config.url === null) return RS_RET.ERR;
    const outcome: HttpPostOutcome = await http.post({
      url: config.url,
      headers: ['Content-Type: application/x-protobuf', 'Content-Encoding: snappy', 'X-Prometheus-Remote-Write-Version: 0.1.0'],
      userAgent: USER_AGENT,
      body: encodeWriteRequest(series),
      timeoutMs: config.timeoutMs,
      tls: { caFile: config.tlsCaFile, certFile: config.tlsCertFile, keyFile: config.tlsKeyFile, insecure: config.tlsInsecureSkipVerify },
    });
    if ('curlCode' in outcome) {
      this.logTransportFailure(outcome.curlCode);
      return RS_RET.SUSPENDED;
    }
    if (outcome.status >= 200 && outcome.status < 300) return RS_RET_OK;
    this.context.runtime.error(`impstats_push: HTTP ${outcome.status} from remote endpoint`, RS_RET.ERR);
    return outcome.status >= HTTP_SERVER_ERROR ? RS_RET.SUSPENDED : RS_RET.ERR;
  }

  private logTransportFailure(code: number): void {
    const url = this.config.url ?? '(null)';
    const runtime = this.context.runtime;
    if (code === CURLE_PEER_FAILED_VERIFICATION || code === CURLE_SSL_CACERT_BADFILE) {
      runtime.error(`impstats_push: TLS verification failed for ${url}. Provide push.tls.cafile or set push.tls.insecureSkipVerify="on" for testing`, RS_RET.ERR);
    } else if (code === CURLE_SSL_CERTPROBLEM) {
      runtime.error(`impstats_push: TLS client cert problem for ${url}. Check push.tls.certfile and push.tls.keyfile`, RS_RET.ERR);
    } else if (code === CURLE_SSL_CONNECT_ERROR) {
      runtime.error(`impstats_push: TLS connection error for ${url}`, RS_RET.ERR);
    } else if (code === CURLE_SSL_ENGINE_NOTFOUND || code === CURLE_SSL_ENGINE_SETFAILED) {
      runtime.error(`impstats_push: TLS engine error for ${url}`, RS_RET.ERR);
    }
    runtime.error(`impstats_push: HTTP request failed: ${curlStrerror(code)}`, RS_RET.ERR);
  }
}
