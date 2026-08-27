import type { IPv4Packet } from '../../../core/types';
import type { AccessMatrix } from '../authz/AccessMatrix';
import {
  adminHasNoPassword, adminTrustsSource, applyAdminAccount, authenticateAdmin,
  type AdminAccountDraft,
} from '../identity/AdminAccounts';
import { PasswordHistory } from '../identity/PasswordHistory';
import type { AdminHttpServer } from './AdminHttpServer';
import type { FirewallCliServer } from './FirewallCliServer';
import {
  DEFAULT_MANAGEMENT_PORTS, MANAGEMENT_IDLE_TIMEOUT_MIN, ManagementLockout,
  serviceOnPort, tcpDestinationPort, withManagementPorts,
  type ManagementPorts,
} from './ManagementAccess';

export class ManagementPlane {
  private readonly allowed = new Map<string, ReadonlySet<string>>();
  private readonly secrets = new Map<string, string>();
  private readonly history = new PasswordHistory();
  private readonly lockout: ManagementLockout;
  private cliServer: FirewallCliServer | null = null;
  private adminServer: AdminHttpServer | null = null;
  private ports: ManagementPorts = DEFAULT_MANAGEMENT_PORTS;
  private idleTimeoutMin = MANAGEMENT_IDLE_TIMEOUT_MIN;
  private httpsRedirect = true;
  private serverCertificate = 'self-sign';

  constructor(private readonly access: AccessMatrix, now: () => number) {
    this.lockout = new ManagementLockout(now);
  }

  attachCliServer(server: FirewallCliServer): void {
    this.cliServer = server;
    server.refresh();
  }

  attachAdminServer(server: AdminHttpServer): void {
    this.adminServer = server;
    server.refresh();
  }

  adminHttpsRedirect(): boolean { return this.httpsRedirect; }

  setAdminHttpsRedirect(enabled: boolean): void {
    this.httpsRedirect = enabled;
  }

  adminServerCertificateName(): string { return this.serverCertificate; }

  setAdminServerCertificate(name: string): void {
    this.serverCertificate = name;
    this.adminServer?.refresh();
  }

  managementPorts(): ManagementPorts { return this.ports; }

  setManagementPorts(patch: Partial<ManagementPorts>): void {
    this.ports = withManagementPorts(this.ports, patch);
    this.cliServer?.refresh();
    this.adminServer?.refresh();
  }

  idleTimeoutMs(): number { return this.idleTimeoutMin * 60_000; }

  setIdleTimeout(minutes: number): void { this.idleTimeoutMin = minutes; }

  setLockout(threshold: number, durationSec: number): void {
    this.lockout.configure(threshold, durationSec);
  }

  lockoutTable(): ManagementLockout { return this.lockout; }

  setAllowedAccess(iface: string, services: readonly string[]): void {
    this.allowed.set(iface, new Set(services.map(s => s.toLowerCase())));
    this.adminServer?.refresh();
  }

  allowsAccess(iface: string, service: string): boolean {
    const declared = this.allowed.get(iface);
    if (declared === undefined) return true;
    return declared.has(service.toLowerCase());
  }

  servedAnywhere(service: string): boolean {
    if (this.allowed.size === 0) return true;
    for (const services of this.allowed.values()) {
      if (services.has(service.toLowerCase())) return true;
    }
    return false;
  }

  allowedAccessOn(iface: string): readonly string[] {
    return [...(this.allowed.get(iface) ?? [])];
  }

  admitsTcp(iface: string, packet: IPv4Packet): boolean {
    const port = tcpDestinationPort(packet);
    if (port === undefined) return true;

    const service = serviceOnPort(this.ports, port);
    if (service === undefined) return true;
    if (!this.allowsAccess(iface, service)) return false;
    return this.trustedSource(packet.sourceIP.toString());
  }

  trustedSource(source: string): boolean {
    const names = this.access.adminNames();
    if (names.length === 0) return true;
    return names.some(name => adminTrustsSource(this.access, name, source));
  }

  refusesSource(source: string): boolean {
    return !this.trustedSource(source);
  }

  isLockedOut(user: string): boolean {
    return this.lockout.isLockedOut(user);
  }

  applyAdmin(admin: AdminAccountDraft): void {
    applyAdminAccount(this.access, this.secrets, admin, this.history);
  }

  passwordHistory(): PasswordHistory { return this.history; }

  authenticate(name: string, password: string, source?: string): boolean {
    return authenticateAdmin(this.access, this.secrets, name, password, source);
  }

  trustsSource(name: string, source: string): boolean {
    return adminTrustsSource(this.access, name, source);
  }

  login(user: string, password: string, source?: string): boolean {
    if (this.lockout.isLockedOut(user)) return false;
    const accepted = this.authenticate(user, password, source);
    if (accepted) this.lockout.recordSuccess(user);
    else this.lockout.recordFailure(user);
    return accepted;
  }

  requiresPasswordChange(name: string): boolean {
    return adminHasNoPassword(this.access, this.secrets, name);
  }

  noteLogin(user: string): void { this.lockout.recordSuccess(user); }

  noteAuthFailure(user: string): void { this.lockout.recordFailure(user); }
}
