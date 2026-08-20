/**
 * WindowsIisRole — the "Web Server (IIS)" Windows role, minimal scope
 * (PRD-Windows-Server.md §5 P11): `W3SVC` + a "Default Web Site" (and any
 * additional `New-Website` sites) each listening on their own real TCP
 * port, serving files from a physical path (`C:\inetpub\wwwroot` by
 * default) with real HTTP status/header semantics (200/404, `Server:
 * Microsoft-IIS/10.0`, `Content-Type`). No app pools, no HTTPS/TLS, no
 * ASP.NET — PRD §2.2 explicitly scopes "IIS avancé" out.
 *
 * Wire convention: migrated by `PRD-HTTP.md` §5 P12 from a JSON-PDU stand-in
 * onto real RFC 9112 framing (`Http1ServerSession`) — one server instance
 * per started site, matching that site's own listening port.
 */

import type { EndHost } from '@/network/devices/EndHost';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import type { WindowsCertStore } from '@/network/devices/windows/CertStore';
import { contentTypeForPath } from '@/network/http/HttpTypes';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { buildHttpsServerConfig } from './IisHttpsBinding';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';

export interface IisOpResult { ok: boolean; message: string }
export interface WebsiteInfo {
  name: string; physicalPath: string; port: number; state: 'Started' | 'Stopped';
  httpsPort?: number; certificateThumbprint?: string; applicationPool: string;
}

/**
 * App pool (PRD-Windows-Server-Advanced.md §5 P15, §2.1.14) — purely
 * process/isolation metadata (identity, recycling, worker count): this
 * simulator never executes real .NET application code in any app pool,
 * matching the already-established convention for simulated Oracle
 * PL/SQL.
 */
export type AppPoolIdentityType = 'ApplicationPoolIdentity' | 'NetworkService' | 'LocalService' | 'LocalSystem';
export interface AppPoolInfo {
  name: string;
  state: 'Started' | 'Stopped';
  managedRuntimeVersion: string;
  identityType: AppPoolIdentityType;
  periodicRestartMinutes: number;
  workerProcessCount: number;
  recycleCount: number;
}
export interface NewAppPoolOptions {
  managedRuntimeVersion?: string;
  identityType?: AppPoolIdentityType;
  periodicRestartMinutes?: number;
  workerProcessCount?: number;
}

/** A static registry of the IIS modules already relevant to this role's own request pipeline — no dynamic third-party module loading. */
export interface WebModuleInfo { name: string; type: string }
const GLOBAL_MODULES: readonly WebModuleInfo[] = [
  { name: 'StaticFileModule', type: 'IIS.WebServer.StaticContent' },
  { name: 'DefaultDocumentModule', type: 'IIS.WebServer.Common' },
  { name: 'HttpErrorsModule', type: 'IIS.WebServer.HttpErrors' },
] as const;

const DEFAULT_APP_POOL = 'DefaultAppPool';

const IIS_SERVER_HEADER = 'Microsoft-IIS/10.0';
const STATIC_ALLOWED_METHODS = 'GET, HEAD, OPTIONS, TRACE';
const DEFAULT_SITE_NAME = 'Default Web Site';
const DEFAULT_PHYSICAL_PATH = 'C:\\inetpub\\wwwroot';
const DEFAULT_DOCUMENT = 'iisstart.htm';
const DEFAULT_PAGE = '<html><head><title>IIS Windows Server</title></head><body><h1>IIS Windows Server</h1><p>This is the default web site.</p></body></html>';

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

interface SiteState extends WebsiteInfo {
  server: Http1ServerSession | null;
  httpsServer: HttpsServerSession | null;
}

export class WindowsIisRole {
  private readonly sites = new Map<string, SiteState>();
  private readonly appPools = new Map<string, AppPoolInfo>();

  constructor(
    private readonly host: EndHost,
    private readonly fs: WindowsFileSystem,
    private readonly certStore: WindowsCertStore,
  ) {
    this.fs.mkdirp(DEFAULT_PHYSICAL_PATH);
    const indexPath = `${DEFAULT_PHYSICAL_PATH}\\${DEFAULT_DOCUMENT}`;
    if (!this.fs.exists(indexPath)) this.fs.createFile(indexPath, DEFAULT_PAGE);
    this.appPools.set(DEFAULT_APP_POOL, this.makeAppPool(DEFAULT_APP_POOL, {}));
    this.sites.set(DEFAULT_SITE_NAME, {
      name: DEFAULT_SITE_NAME, physicalPath: DEFAULT_PHYSICAL_PATH, port: 80, state: 'Stopped',
      applicationPool: DEFAULT_APP_POOL, server: null, httpsServer: null,
    });
  }

  start(): void { this.startSite(DEFAULT_SITE_NAME); }
  stop(): void { for (const name of this.sites.keys()) this.stopSite(name); }
  isRunning(): boolean { return [...this.sites.values()].some(s => s.state === 'Started'); }

  // ─── Sites (New-Website / Get-Website / Start-Website / Stop-Website) ──

  newWebsite(name: string, physicalPath: string, port: number, applicationPool: string = DEFAULT_APP_POOL): IisOpResult {
    if (this.sites.has(name)) return { ok: false, message: `New-Website : A website named "${name}" already exists.` };
    this.fs.mkdirp(physicalPath);
    this.sites.set(name, {
      name, physicalPath, port, state: 'Stopped', applicationPool, server: null, httpsServer: null,
    });
    this.startSite(name);
    return { ok: true, message: '' };
  }

  removeWebsite(name: string): IisOpResult {
    const site = this.sites.get(name);
    if (!site) return { ok: false, message: `Remove-Website : A website named "${name}" does not exist.` };
    this.stopSite(name);
    site.httpsServer?.stop();
    this.sites.delete(name);
    return { ok: true, message: '' };
  }

  /**
   * `New-WebBinding -Name <site> -Protocol https -Port <port> -CertificateHash
   * <thumbprint>` (PRD-Windows-Server-Advanced.md §5 P14) — binds a second,
   * real TLS 1.3 listener to an existing site, serving the exact same
   * content as its HTTP binding. The certificate must already be in the
   * device's `WindowsCertStore` (issued by AD CS §5 P13, or self-signed) —
   * zero new TLS primitive, `HttpsServerSession`/`TlsServerSession` do all
   * the actual work.
   */
  newBinding(siteName: string, protocol: 'http' | 'https', port: number, certificateThumbprint?: string): IisOpResult {
    const site = this.sites.get(siteName);
    if (!site) return { ok: false, message: `New-WebBinding : A website named "${siteName}" does not exist.` };
    if (protocol === 'http') {
      return { ok: false, message: 'New-WebBinding : A binding for this protocol already exists (use New-Website to create additional sites).' };
    }
    if (!certificateThumbprint) {
      return { ok: false, message: 'New-WebBinding : Cannot process command because of one or more missing mandatory parameters: CertificateHash.' };
    }
    const entry = this.certStore.get(certificateThumbprint);
    if (!entry) {
      return { ok: false, message: `New-WebBinding : Cannot find the certificate hash specified: ${certificateThumbprint}.` };
    }
    site.httpsServer?.stop();
    const httpsServer = new HttpsServerSession(
      this.host.getTcpStack(), port, buildHttpsServerConfig(entry), (req) => this.buildResponse(site, req),
    );
    httpsServer.start();
    site.httpsServer = httpsServer;
    site.httpsPort = port;
    site.certificateThumbprint = certificateThumbprint;
    return { ok: true, message: '' };
  }

  startSite(name: string): IisOpResult {
    const site = this.sites.get(name);
    if (!site) return { ok: false, message: `Start-Website : A website named "${name}" does not exist.` };
    if (site.state === 'Started') return { ok: true, message: '' };
    const server = new Http1ServerSession(this.host.getTcpStack(), site.port, (req) => this.buildResponse(site, req));
    server.start();
    site.server = server;
    site.state = 'Started';
    if (site.httpsPort !== undefined && site.certificateThumbprint !== undefined) {
      this.newBinding(name, 'https', site.httpsPort, site.certificateThumbprint);
    }
    return { ok: true, message: '' };
  }

  stopSite(name: string): IisOpResult {
    const site = this.sites.get(name);
    if (!site) return { ok: false, message: `Stop-Website : A website named "${name}" does not exist.` };
    if (site.state === 'Stopped') return { ok: true, message: '' };
    site.server?.stop();
    site.server = null;
    site.httpsServer?.stop();
    site.httpsServer = null;
    site.state = 'Stopped';
    return { ok: true, message: '' };
  }

  /** `iisreset` — restarts every currently-running site (a site explicitly stopped via `Stop-Website` stays stopped, matching real IIS's per-site state surviving a W3SVC restart). */
  iisreset(): void {
    const running = [...this.sites.values()].filter(s => s.state === 'Started').map(s => s.name);
    for (const name of running) this.stopSite(name);
    for (const name of running) this.startSite(name);
  }

  private toInfo(s: SiteState): WebsiteInfo {
    return {
      name: s.name, physicalPath: s.physicalPath, port: s.port, state: s.state,
      httpsPort: s.httpsPort, certificateThumbprint: s.certificateThumbprint, applicationPool: s.applicationPool,
    };
  }

  getWebsite(name: string): WebsiteInfo | null {
    const site = this.sites.get(name);
    return site ? this.toInfo(site) : null;
  }

  listWebsites(): WebsiteInfo[] {
    return [...this.sites.values()].map(s => this.toInfo(s));
  }

  // ─── App pools (New-WebAppPool / Get-IISAppPool) — PRD §5 P15 ─────────

  private makeAppPool(name: string, opts: NewAppPoolOptions): AppPoolInfo {
    return {
      name, state: 'Started',
      managedRuntimeVersion: opts.managedRuntimeVersion ?? 'v4.0',
      identityType: opts.identityType ?? 'ApplicationPoolIdentity',
      periodicRestartMinutes: opts.periodicRestartMinutes ?? 1740,
      workerProcessCount: opts.workerProcessCount ?? 1,
      recycleCount: 0,
    };
  }

  newAppPool(name: string, opts: NewAppPoolOptions = {}): IisOpResult {
    if (this.appPools.has(name)) return { ok: false, message: `New-WebAppPool : An application pool named "${name}" already exists.` };
    this.appPools.set(name, this.makeAppPool(name, opts));
    return { ok: true, message: '' };
  }

  removeAppPool(name: string): IisOpResult {
    if (name === DEFAULT_APP_POOL) return { ok: false, message: 'Remove-WebAppPool : The default application pool cannot be removed.' };
    if (!this.appPools.has(name)) return { ok: false, message: `Remove-WebAppPool : An application pool named "${name}" does not exist.` };
    this.appPools.delete(name);
    return { ok: true, message: '' };
  }

  startAppPool(name: string): IisOpResult {
    const pool = this.appPools.get(name);
    if (!pool) return { ok: false, message: `Start-WebAppPool : An application pool named "${name}" does not exist.` };
    pool.state = 'Started';
    return { ok: true, message: '' };
  }

  stopAppPool(name: string): IisOpResult {
    const pool = this.appPools.get(name);
    if (!pool) return { ok: false, message: `Stop-WebAppPool : An application pool named "${name}" does not exist.` };
    pool.state = 'Stopped';
    return { ok: true, message: '' };
  }

  /** `Restart-WebAppPool` — a purely cosmetic recycle: bumps `recycleCount`, no process/state actually restarts (this simulator runs no real worker process). */
  recycleAppPool(name: string): IisOpResult {
    const pool = this.appPools.get(name);
    if (!pool) return { ok: false, message: `Restart-WebAppPool : An application pool named "${name}" does not exist.` };
    pool.recycleCount += 1;
    return { ok: true, message: '' };
  }

  getAppPool(name: string): AppPoolInfo | null {
    const pool = this.appPools.get(name);
    return pool ? { ...pool } : null;
  }

  listAppPools(): AppPoolInfo[] {
    return [...this.appPools.values()].map(p => ({ ...p }));
  }

  // ─── Global modules (Get-WebGlobalModule) — PRD §5 P15 ─────────────────

  listGlobalModules(): WebModuleInfo[] {
    return [...GLOBAL_MODULES];
  }

  // ─── Request handling ────────────────────────────────────────────────

  private buildResponse(site: SiteState, req: HttpMessage): HttpMessage {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      const res = createResponse(200, 'OK');
      res.headers.set('Server', IIS_SERVER_HEADER);
      res.headers.set('Allow', STATIC_ALLOWED_METHODS);
      res.headers.set('Content-Length', '0');
      return res;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      const res = createResponse(405, 'Method Not Allowed');
      res.headers.set('Server', IIS_SERVER_HEADER);
      res.headers.set('Allow', STATIC_ALLOWED_METHODS);
      res.headers.set('Content-Type', 'text/html');
      res.body = binaryStringToBytes('<html><body><h1>405 - HTTP verb used to access this page is not allowed.</h1></body></html>');
      return res;
    }
    const reqPath = !req.target || req.target === '/' ? `/${DEFAULT_DOCUMENT}` : req.target;
    const fsPath = `${site.physicalPath}${reqPath.replace(/\//g, '\\')}`;
    const file = this.fs.readFile(fsPath);
    if (!file.ok) {
      const res = createResponse(404, 'Not Found');
      res.headers.set('Server', IIS_SERVER_HEADER);
      res.headers.set('Content-Type', 'text/html');
      res.body = binaryStringToBytes('<html><body><h1>404 - File or directory not found.</h1></body></html>');
      return res;
    }
    const res = createResponse(200, 'OK');
    res.headers.set('Server', IIS_SERVER_HEADER);
    res.headers.set('Content-Type', contentTypeForPath(fsPath));
    res.body = binaryStringToBytes(file.content ?? '');
    return res;
  }
}
