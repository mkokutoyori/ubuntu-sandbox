import type { EthernetFrame, IPv4Packet } from '../../../core/types';
import type { IEventBus } from '../../../../events/EventBus';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { Port } from '../../../hardware/Port';
import type { SessionTable } from '../session/SessionTable';
import type { VdomContext } from '../vdom/VdomRegistry';
import type { CertificateStore } from '../vpn/CertificateStore';
import type { RemoteAuthOutcome } from '../auth/AuthPortal';
import { buildFirewallPortals, type FirewallPortals } from '../auth/FirewallPortals';
import { buildFirewallHa, type FirewallHa } from '../ha/FirewallHa';
import { buildFirewallNtp, type FirewallNtp } from './FirewallNtp';
import {
  CAPTURED_HTTP_PORT, CaptivePortalRedirect,
} from '../auth/CaptivePortalRedirect';
import {
  AdminHttpServer, type AdminHttpApp, type AdminServerCertificate,
} from './AdminHttpServer';
import { FirewallCliServer, type ManagementCli } from './FirewallCliServer';
import type { LoginBannerStage } from './LoginBanners';
import type { ManagementPorts } from './ManagementAccess';

export const HA_COMMAND_SOURCE = 'ha-cluster';

export interface ManagementHost {
  readonly deviceId: string;
  readonly deviceName: string;
  hostname(): string;
  bus(): IEventBus;
  now(): number;
  tcp(): TcpStack;
  vdom(name?: string): VdomContext;
  certificates(): CertificateStore;
  remoteAuthenticate(
    server: string, user: string, password: string,
  ): Promise<RemoteAuthOutcome>;
  serial(): string;
  port(iface: string): Port | undefined;
  ports(): Port[];
  sendFrame(iface: string, frame: EthernetFrame): void;
  sessions(): SessionTable;
  connectedRoutes(): ReadonlyArray<{ network: string; mask: string; iface: string }>;
  addressOf(iface: string): string | undefined;
  authenticated(iface: string, address: string): boolean;
  authRequiredByPolicy(): boolean;
  portalUsesHttps(): boolean;
  managementPorts(): ManagementPorts;
  createManagementCli(user: string, origin: string): ManagementCli | null;
  authenticateAdmin(user: string, password: string, source: string): boolean;
  knownAdmin(user: string): boolean;
  refuseManagementSource(source: string): boolean;
  managementIdleTimeoutMs(): number | null;
  runningConfig(): string;
  onManagementLogin(user: string, source: string): void;
  onAdminLogout(user: string): void;
  onManagementAuthFailure(user: string, source: string): void;
  loginBannerLines(stage: LoginBannerStage): readonly string[];
  adminHttpsRedirect(): boolean;
  adminServerCertificate(): AdminServerCertificate | undefined;
  managementServedAnywhere(service: 'http' | 'https'): boolean;
  adminHttpApp(): AdminHttpApp | null;
}

export interface ManagementServices {
  readonly portals: FirewallPortals;
  readonly ha: FirewallHa;
  readonly ntp: FirewallNtp;
  readonly captivePortal: CaptivePortalRedirect;
  readonly cli: FirewallCliServer;
  readonly admin: AdminHttpServer;
}

export function buildManagementServices(host: ManagementHost): ManagementServices {
  const portals = buildFirewallPortals({
    tcp: host.tcp(),
    now: () => host.now(),
    vdom: (name?: string) => host.vdom(name),
    certificates: () => host.certificates(),
    remoteAuthenticate: (server, user, password) =>
      host.remoteAuthenticate(server, user, password),
  });

  const ha = buildFirewallHa({
    serial: () => host.serial(),
    hostname: () => host.hostname(),
    now: () => host.now(),
    sendFrame: (iface, frame) => { host.sendFrame(iface, frame); },
    port: (iface) => host.port(iface),
    sessions: () => host.sessions(),
    authenticateAdmin: (admin, secret) =>
      host.authenticateAdmin(admin, secret, HA_COMMAND_SOURCE),
    runManagementCommand: (admin, line) =>
      host.createManagementCli(admin, HA_COMMAND_SOURCE)?.execute(line) ?? '',
  });

  const ntp = buildFirewallNtp({
    deviceId: host.deviceId,
    deviceName: host.deviceName,
    hostname: () => host.hostname(),
    port: (name) => host.port(name),
    ports: () => host.ports(),
    sendFrame: (name, frame) => { host.sendFrame(name, frame); },
    bus: () => host.bus(),
  });

  const admin = new AdminHttpServer({
    tcp: () => host.tcp(),
    ports: () => host.managementPorts(),
    httpsRedirect: () => host.adminHttpsRedirect(),
    serverCertificate: () => host.adminServerCertificate(),
    app: () => host.adminHttpApp(),
    capturePort: () => (captivePortal.isArmed() ? CAPTURED_HTTP_PORT : null),
    capturedResponse: (client) => captivePortal.responseFor(client),
    servedAnywhere: (service) => host.managementServedAnywhere(service),
  });

  const captivePortal = new CaptivePortalRedirect({
    tcp: () => host.tcp(),
    portalPort: () => (host.portalUsesHttps() ? portals.ports().https : portals.ports().http),
    portalScheme: () => (host.portalUsesHttps() ? 'https' : 'http'),
    connectedRoutes: () => host.connectedRoutes(),
    addressOf: (iface) => host.addressOf(iface),
    authenticated: (iface, address) => host.authenticated(iface, address),
    authRequiredByPolicy: () => host.authRequiredByPolicy(),
    onArmedChanged: () => { admin.refresh(); },
  });

  const cli = new FirewallCliServer({
    tcp: () => host.tcp(),
    hostname: () => host.hostname(),
    ports: () => host.managementPorts(),
    createCli: (user, origin) => host.createManagementCli(user, origin),
    authenticate: (user, password, source) =>
      host.authenticateAdmin(user, password, source),
    knownAdmin: (user) => host.knownAdmin(user),
    refuseSource: (source) => host.refuseManagementSource(source),
    idleTimeoutMs: () => host.managementIdleTimeoutMs(),
    runningConfig: () => host.runningConfig(),
    onLogin: (user, source) => { host.onManagementLogin(user, source); },
    onLogout: (user) => { host.onAdminLogout(user); },
    onAuthFailure: (user, source) => { host.onManagementAuthFailure(user, source); },
    bannerLines: (stage) => host.loginBannerLines(stage),
  });

  return Object.freeze({ portals, ha, ntp, captivePortal, cli, admin });
}

export function ipv4Claimed(
  captivePortal: CaptivePortalRedirect, iface: string, packet: IPv4Packet,
): boolean {
  return captivePortal.claims(iface, packet);
}
