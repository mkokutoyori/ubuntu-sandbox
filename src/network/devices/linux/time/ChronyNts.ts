import { simulationNowMs } from '@/network/core/SystemClock';
import { systemRandom, type RandomSource } from '@/crypto/random';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { ListenerIdentity } from '../../../tcp/ListenerSocketSink';
import type { X509Certificate } from '../../../pki/X509Certificate';
import { CertificateVerifier } from '../../../pki/CertificateVerifier';
import { pemToCertChain, pemToPrivateKey } from '../../../pki/pem';
import type { TlsServerConfig, TlsServerCredential } from '../../../tls/TlsServerSession';
import type { NtpAssociation } from '../../../ntp/types';
import type { NtsSupport } from '../../../ntp/NtpAgent';
import { NtsClient, KE_RETRY_FACTOR_CONNECT, KE_RETRY_FACTOR_TLS } from '../../../nts/NtsClient';
import { NtsKeServer } from '../../../nts/NtsKeServer';
import { runNtsKe } from '../../../nts/NtsKeClient';
import { NtsServerKeys, KEYS_DUMP_FILENAME } from '../../../nts/NtsServerKeys';
import { dumpCookies, restoreCookies, type RestoredCookies } from '../../../nts/NtsDump';
import type { ChronyConf, ChronySource } from './ChronyConfig';

export interface ChronyNtsHost {
  readFile(path: string): string | null;
  listDirectory?(path: string): readonly string[] | null;
  writeFile?(path: string, content: string, mode: number): boolean;
  tcpStack?(): TcpStack;
  trustAnchors?(): readonly X509Certificate[];
  identity?(): ListenerIdentity;
  log?(message: string): void;
}

interface TrackedSource {
  readonly client: NtsClient;
  readonly source: ChronySource;
}

export interface NtsKeStatistics {
  accepted: number;
  dropped: number;
}

export interface NtsKeClientLogEntry {
  hits: number;
  drops: number;
  lastMs: number;
  intervalExponent: number;
}

export class ChronyNts implements NtsSupport {
  private readonly tracked = new Map<string, TrackedSource>();
  private keys: NtsServerKeys | null = null;
  private server: NtsKeServer | null = null;
  private serverSignature = '';
  private conf: ChronyConf['nts'] | null = null;
  readonly statistics: NtsKeStatistics = { accepted: 0, dropped: 0 };
  private readonly keLog = new Map<string, NtsKeClientLogEntry>();

  getKeLog(): ReadonlyMap<string, NtsKeClientLogEntry> { return this.keLog; }

  clearKeLog(): void { this.keLog.clear(); }

  private logKeClient(ip: string, dropped: boolean): void {
    const now = simulationNowMs();
    const entry = this.keLog.get(ip) ?? { hits: 0, drops: 0, lastMs: 0, intervalExponent: 127 };
    if (entry.hits > 0 && now > entry.lastMs) entry.intervalExponent = Math.round(Math.log2((now - entry.lastMs) / 1000));
    entry.hits++;
    if (dropped) entry.drops++;
    entry.lastMs = now;
    this.keLog.set(ip, entry);
  }

  constructor(
    private readonly host: ChronyNtsHost, private readonly ntpPort: () => number,
    private readonly random: RandomSource = systemRandom,
  ) {}

  active(): boolean { return this.tracked.size > 0 || this.keys !== null; }

  randomBytes(length: number): Uint8Array { return this.random(length); }

  serverKeys(): NtsServerKeys | null {
    if (this.keys !== null && this.conf !== null && this.conf.rotateSeconds > 0 && this.keys.rotateIfDue(simulationNowMs())) this.saveKeys();
    return this.keys;
  }

  client(association: NtpAssociation): NtsClient | null {
    return this.tracked.get(association.serverIp)?.client ?? null;
  }

  isServing(): boolean { return this.server !== null && this.server.isRunning(); }

  sourceClient(ip: string): NtsClient | null { return this.tracked.get(ip)?.client ?? null; }

  track(source: ChronySource, nowMs: number): RestoredCookies | null {
    if (!source.nts) { this.tracked.delete(source.hote); return null; }
    const existing = this.tracked.get(source.hote);
    if (existing !== undefined && existing.source.ntsPort === source.ntsPort && existing.source.certSet === source.certSet) return null;
    const client = new NtsClient(this.random, (this.conf?.refreshSeconds ?? 2419200) * 1000);
    this.tracked.set(source.hote, { client, source });
    return this.loadCookies(source, client, nowMs);
  }

  untrack(ip: string): void { this.tracked.delete(ip); }

  forget(): void { this.tracked.clear(); }

  keyExchange(association: NtpAssociation, client: NtsClient, nowMs: number): void {
    const entry = this.tracked.get(association.serverIp);
    const tcp = this.host.tcpStack?.();
    if (entry === undefined || tcp === undefined) return;
    if (!client.beginKeyExchange(nowMs)) return;
    const verifier = new CertificateVerifier({ trustAnchors: this.trustSet(entry.source.certSet) });
    const outcome = runNtsKe(tcp, association.serverIp, entry.source.ntsPort, association.serverIp, verifier);
    if (!outcome.ok) {
      client.failKeyExchange(outcome.stage === 'connect' ? KE_RETRY_FACTOR_CONNECT : KE_RETRY_FACTOR_TLS, nowMs);
      this.host.log?.(outcome.stage === 'connect'
        ? `Could not connect to ${association.serverIp}:${entry.source.ntsPort}`
        : `NTS-KE with ${association.serverIp}:${entry.source.ntsPort} failed: ${outcome.reason}`);
      return;
    }
    const result = outcome.result;
    if (result.ntpServer !== null && result.ntpServer !== association.serverIp) {
      client.failKeyExchange(KE_RETRY_FACTOR_TLS, nowMs);
      this.host.log?.(`Could not change ${association.serverIp} to negotiated address ${result.ntpServer}`);
      return;
    }
    if (result.ntpPort !== null) association.port = result.ntpPort;
    client.install(result.context, result.cookies, nowMs);
  }

  private trustSet(set: number): X509Certificate[] {
    const anchors: X509Certificate[] = [];
    if (set === 0 && (this.conf?.systemCerts ?? true)) anchors.push(...(this.host.trustAnchors?.() ?? []));
    for (const entry of this.conf?.trustedCerts ?? []) {
      if (entry.set !== set) continue;
      const names = this.host.listDirectory?.(entry.path);
      const paths = names === null || names === undefined ? [entry.path] : names.map((name) => `${entry.path.replace(/\/$/, '')}/${name}`);
      for (const path of paths) anchors.push(...pemToCertChain(this.host.readFile(path) ?? ''));
    }
    return anchors;
  }

  apply(conf: ChronyConf['nts']): void {
    this.conf = conf;
    for (const entry of this.tracked.values()) entry.client.refreshMs = conf.refreshSeconds * 1000;
    const configured = conf.serverCerts.length > 0 && conf.serverKeys.length > 0;
    const signature = configured ? JSON.stringify([conf.serverCerts, conf.serverKeys, conf.port, conf.rotateSeconds, conf.maxConnections]) : '';
    if (signature === this.serverSignature && (this.server !== null) === configured) return;
    this.stopServer();
    this.serverSignature = signature;
    if (configured) this.startServer(conf);
  }

  private credentials(conf: ChronyConf['nts']): TlsServerConfig | null {
    const credentials: TlsServerCredential[] = [];
    for (let i = 0; i < conf.serverCerts.length; i++) {
      const certificates = pemToCertChain(this.host.readFile(conf.serverCerts[i]) ?? '');
      const privateKey = pemToPrivateKey(this.host.readFile(conf.serverKeys[i] ?? '') ?? '');
      if (certificates.length === 0 || privateKey === null) {
        this.host.log?.(`Could not set credentials : ${conf.serverCerts[i]}`);
        return null;
      }
      credentials.push({ cert: certificates[0], privateKey, chain: certificates.slice(1) });
    }
    const [first, ...others] = credentials;
    return {
      serverCert: first.cert, serverPrivateKey: first.privateKey, serverChain: first.chain,
      ...(others.length > 0 ? { sniCredentials: others } : {}),
    };
  }

  private startServer(conf: ChronyConf['nts']): void {
    const tcp = this.host.tcpStack?.();
    const config = this.credentials(conf);
    if (tcp === undefined || config === null) return;
    this.keys = new NtsServerKeys(this.random, simulationNowMs(), conf.rotateSeconds);
    this.loadKeys(conf);
    if (conf.rotateSeconds > 0) this.saveKeys();
    const server = new NtsKeServer(tcp, conf.port, {
      tlsConfig: () => config,
      keys: () => this.serverKeys()!,
      ntpPort: () => this.ntpPort(),
      ntpServer: () => this.conf?.ntpServer ?? null,
      maxConnections: () => this.conf?.maxConnections ?? 100,
      onAccepted: (ip) => { this.statistics.accepted++; this.logKeClient(ip, false); },
      onDropped: (ip) => { this.statistics.dropped++; this.logKeClient(ip, true); },
    });
    server.start(this.host.identity?.());
    this.server = server;
  }

  private stopServer(): void {
    this.server?.stop();
    this.server = null;
    this.keys = null;
  }

  shutdown(portOf?: (ip: string) => number): void {
    this.dump(portOf);
    this.stopServer();
    this.serverSignature = '';
    this.tracked.clear();
  }

  reloadKeys(): boolean {
    if (this.keys === null || this.conf === null) return false;
    return this.loadKeys(this.conf);
  }

  private dumpPath(name: string): string | null {
    const directory = this.conf?.dumpDir ?? '';
    return directory === '' ? null : `${directory.replace(/\/$/, '')}/${name}`;
  }

  private loadKeys(conf: ChronyConf['nts']): boolean {
    const path = this.dumpPath(KEYS_DUMP_FILENAME);
    const text = path === null ? null : this.host.readFile(path);
    if (text === null || this.keys === null) return false;
    const loaded = this.keys.restoreText(text, simulationNowMs());
    this.host.log?.(loaded ? 'Loaded server NTS keys' : 'Could not load server NTS keys');
    return loaded && conf.rotateSeconds >= 0;
  }

  private saveKeys(): void {
    const path = this.dumpPath(KEYS_DUMP_FILENAME);
    if (path === null || this.keys === null || (this.conf?.rotateSeconds ?? 0) === 0) return;
    this.host.writeFile?.(path, this.keys.dumpText(simulationNowMs()), 0o600);
  }

  private loadCookies(source: ChronySource, client: NtsClient, nowMs: number): RestoredCookies | null {
    const path = this.dumpPath(`${source.hote}.nts`);
    const text = path === null ? null : this.host.readFile(path);
    return text === null ? null : restoreCookies(client, source.hote, text, nowMs, nowMs);
  }

  dump(portOf: (ip: string) => number = () => 123): void {
    const nowMs = simulationNowMs();
    for (const [ip, entry] of this.tracked) {
      const path = this.dumpPath(`${ip}.nts`);
      if (path === null) continue;
      const text = dumpCookies(entry.client, { name: ip, ntpAddress: ip, ntpPort: portOf(ip) }, nowMs, nowMs);
      if (text !== null) this.host.writeFile?.(path, text, 0o600);
    }
    this.saveKeys();
  }

  currentKeyId(): number | null { return this.keys === null ? null : this.keys.currentKeyId(); }
}
