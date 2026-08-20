import { IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';

export type ManagementService =
  'ping' | 'https' | 'http' | 'ssh' | 'telnet' | 'snmp';

export const MANAGEMENT_SERVICES: readonly ManagementService[] =
  Object.freeze(['ping', 'https', 'http', 'ssh', 'telnet', 'snmp'] as const);

export interface ManagementPorts {
  readonly ssh: number;
  readonly telnet: number;
  readonly http: number;
  readonly https: number;
  readonly snmp: number;
}

export const DEFAULT_MANAGEMENT_PORTS: ManagementPorts = Object.freeze({
  ssh: 22, telnet: 23, http: 80, https: 443, snmp: 161,
});

export const MANAGEMENT_LOCKOUT_THRESHOLD = 3;
export const MANAGEMENT_LOCKOUT_DURATION_SEC = 60;
export const MANAGEMENT_IDLE_TIMEOUT_MIN = 5;

export function serviceOnPort(
  ports: ManagementPorts, port: number,
): ManagementService | undefined {
  if (port === ports.ssh) return 'ssh';
  if (port === ports.telnet) return 'telnet';
  if (port === ports.https) return 'https';
  if (port === ports.http) return 'http';
  if (port === ports.snmp) return 'snmp';
  return undefined;
}

export function withManagementPorts(
  base: ManagementPorts, patch: Partial<ManagementPorts>,
): ManagementPorts {
  return Object.freeze({
    ssh: patch.ssh ?? base.ssh,
    telnet: patch.telnet ?? base.telnet,
    http: patch.http ?? base.http,
    https: patch.https ?? base.https,
    snmp: patch.snmp ?? base.snmp,
  });
}

export function tcpDestinationPort(packet: IPv4Packet): number | undefined {
  if (packet.protocol !== IP_PROTO_TCP) return undefined;
  const segment = packet.payload as {
    type?: string; destinationPort?: number;
  } | undefined;
  return segment?.type === 'tcp' ? segment.destinationPort : undefined;
}

export class ManagementLockout {
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private threshold = MANAGEMENT_LOCKOUT_THRESHOLD,
    private durationSec = MANAGEMENT_LOCKOUT_DURATION_SEC,
  ) {}

  configure(threshold: number, durationSec: number): void {
    this.threshold = threshold;
    this.durationSec = durationSec;
  }

  isLockedOut(source: string): boolean {
    const until = this.lockedUntil.get(source);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.lockedUntil.delete(source);
    this.failures.delete(source);
    return false;
  }

  recordFailure(source: string): void {
    if (this.threshold <= 0) return;
    const at = this.now();
    const seen = [...(this.failures.get(source) ?? []), at];
    this.failures.set(source, seen);
    if (seen.length >= this.threshold) {
      this.lockedUntil.set(source, at + this.durationSec * 1000);
    }
  }

  recordSuccess(source: string): void {
    this.failures.delete(source);
    this.lockedUntil.delete(source);
  }
}
