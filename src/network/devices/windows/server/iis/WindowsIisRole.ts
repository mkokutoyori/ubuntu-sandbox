/**
 * WindowsIisRole — the "Web Server (IIS)" Windows role, minimal scope
 * (PRD-Windows-Server.md §5 P11): `W3SVC` + a "Default Web Site" (and any
 * additional `New-Website` sites) each listening on their own real TCP
 * port, serving files from a physical path (`C:\inetpub\wwwroot` by
 * default) with real HTTP status/header semantics (200/404, `Server:
 * Microsoft-IIS/10.0`, `Content-Type`). No app pools, no HTTPS/TLS, no
 * ASP.NET — PRD §2.2 explicitly scopes "IIS avancé" out.
 *
 * Wire convention: see `HttpTypes.ts` — a typed request/response PDU
 * (JSON text) over a real `TcpConnection`, matching this codebase's
 * established SMB convention rather than hand-rolled HTTP/1.1 text
 * framing (PRD §3 "PDU objets sur le transport réel").
 */

import type { EndHost } from '@/network/devices/EndHost';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { type HttpRequestPdu, type HttpResponsePdu, isHttpRequestPdu, contentTypeForPath } from '@/network/http/HttpTypes';

export interface IisOpResult { ok: boolean; message: string }
export interface WebsiteInfo { name: string; physicalPath: string; port: number; state: 'Started' | 'Stopped' }

const IIS_SERVER_HEADER = 'Microsoft-IIS/10.0';
const DEFAULT_SITE_NAME = 'Default Web Site';
const DEFAULT_PHYSICAL_PATH = 'C:\\inetpub\\wwwroot';
const DEFAULT_DOCUMENT = 'iisstart.htm';
const DEFAULT_PAGE = '<html><head><title>IIS Windows Server</title></head><body><h1>IIS Windows Server</h1><p>This is the default web site.</p></body></html>';

type SiteState = WebsiteInfo;

export class WindowsIisRole {
  private readonly sites = new Map<string, SiteState>();

  constructor(private readonly host: EndHost, private readonly fs: WindowsFileSystem) {
    this.fs.mkdirp(DEFAULT_PHYSICAL_PATH);
    const indexPath = `${DEFAULT_PHYSICAL_PATH}\\${DEFAULT_DOCUMENT}`;
    if (!this.fs.exists(indexPath)) this.fs.createFile(indexPath, DEFAULT_PAGE);
    this.sites.set(DEFAULT_SITE_NAME, {
      name: DEFAULT_SITE_NAME, physicalPath: DEFAULT_PHYSICAL_PATH, port: 80, state: 'Stopped',
    });
  }

  start(): void { this.startSite(DEFAULT_SITE_NAME); }
  stop(): void { for (const name of this.sites.keys()) this.stopSite(name); }
  isRunning(): boolean { return [...this.sites.values()].some(s => s.state === 'Started'); }

  // ─── Sites (New-Website / Get-Website / Start-Website / Stop-Website) ──

  newWebsite(name: string, physicalPath: string, port: number): IisOpResult {
    if (this.sites.has(name)) return { ok: false, message: `New-Website : A website named "${name}" already exists.` };
    this.fs.mkdirp(physicalPath);
    this.sites.set(name, { name, physicalPath, port, state: 'Stopped' });
    this.startSite(name);
    return { ok: true, message: '' };
  }

  removeWebsite(name: string): IisOpResult {
    const site = this.sites.get(name);
    if (!site) return { ok: false, message: `Remove-Website : A website named "${name}" does not exist.` };
    this.stopSite(name);
    this.sites.delete(name);
    return { ok: true, message: '' };
  }

  startSite(name: string): IisOpResult {
    const site = this.sites.get(name);
    if (!site) return { ok: false, message: `Start-Website : A website named "${name}" does not exist.` };
    if (site.state === 'Started') return { ok: true, message: '' };
    this.host.getTcpStack().listen(site.port, {
      onAccept: (socket: TcpSocket) => this.handleConnection(socket, site),
    });
    site.state = 'Started';
    return { ok: true, message: '' };
  }

  stopSite(name: string): IisOpResult {
    const site = this.sites.get(name);
    if (!site) return { ok: false, message: `Stop-Website : A website named "${name}" does not exist.` };
    if (site.state === 'Stopped') return { ok: true, message: '' };
    this.host.getTcpStack().closeListener(site.port);
    site.state = 'Stopped';
    return { ok: true, message: '' };
  }

  /** `iisreset` — restarts every currently-running site (a site explicitly stopped via `Stop-Website` stays stopped, matching real IIS's per-site state surviving a W3SVC restart). */
  iisreset(): void {
    const running = [...this.sites.values()].filter(s => s.state === 'Started').map(s => s.name);
    for (const name of running) this.stopSite(name);
    for (const name of running) this.startSite(name);
  }

  getWebsite(name: string): WebsiteInfo | null {
    const site = this.sites.get(name);
    return site ? { name: site.name, physicalPath: site.physicalPath, port: site.port, state: site.state } : null;
  }

  listWebsites(): WebsiteInfo[] {
    return [...this.sites.values()].map(s => ({ name: s.name, physicalPath: s.physicalPath, port: s.port, state: s.state }));
  }

  // ─── Request handling ────────────────────────────────────────────────

  private handleConnection(socket: TcpSocket, site: SiteState): void {
    socket.onData((data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { socket.close(); return; }
      if (!isHttpRequestPdu(parsed)) { socket.close(); return; }
      socket.write(JSON.stringify(this.buildResponse(site, parsed)));
      socket.close();
    });
  }

  private buildResponse(site: SiteState, req: HttpRequestPdu): HttpResponsePdu {
    const reqPath = req.path === '/' || req.path === '' ? `/${DEFAULT_DOCUMENT}` : req.path;
    const fsPath = `${site.physicalPath}${reqPath.replace(/\//g, '\\')}`;
    const file = this.fs.readFile(fsPath);
    if (!file.ok) {
      return {
        type: 'http-response', statusCode: 404, statusText: 'Not Found',
        headers: { Server: IIS_SERVER_HEADER, 'Content-Type': 'text/html' },
        body: '<html><body><h1>404 - File or directory not found.</h1></body></html>',
      };
    }
    return {
      type: 'http-response', statusCode: 200, statusText: 'OK',
      headers: { Server: IIS_SERVER_HEADER, 'Content-Type': contentTypeForPath(fsPath) },
      body: file.content ?? '',
    };
  }
}
