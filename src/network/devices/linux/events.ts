/**
 * Linux process & service — reactive event taxonomy.
 *
 * Covers the in-VM process table (`LinuxProcessManager`) and the
 * systemd-ish service layer (`LinuxServiceManager`). Topics are
 * deviceId-scoped so several Linux hosts on one shared bus never
 * collide.
 *
 * Design intent: payloads are plain serialisable records (no class
 * coupling) and deliberately carry more context than today's callers
 * consume — `serviceName`, `nice`, `mainPid`, `type`… — because a
 * live process panel, a supervisor that auto-restarts crashed daemons,
 * or accounting/telemetry are natural next consumers of this stream.
 *
 * Strategy (mirrors the Host taxonomy): events are emitted *alongside*
 * the legacy `onLifecycle` callback, not replacing it, so existing
 * subscribers keep working while new consumers move to the bus.
 */

import type { ProcessState } from './LinuxProcessManager';
import type { ServiceState, EnabledState } from './LinuxServiceManager';

// ── Identity ────────────────────────────────────────────────────────────

export interface LinuxDeviceRef {
  deviceId: string;
}

export interface ProcessRef extends LinuxDeviceRef {
  pid: number;
  /** Short command name (argv[0] basename). */
  comm: string;
}

export interface ServiceRef extends LinuxDeviceRef {
  /** Unit name without the `.service` suffix. */
  name: string;
}

// ── Process lifecycle ───────────────────────────────────────────────────

export interface ProcessSpawnedPayload extends ProcessRef {
  ppid: number;
  command: string;
  user: string;
  uid: number;
  /** Set when the process is the main pid of a systemd unit. */
  serviceName?: string;
}

export interface ProcessExitedPayload extends ProcessRef {
  /** Signal that terminated it, when the exit was signal-driven. */
  signal?: string;
  /** Children reparented to init as a result of this exit. */
  reparented: number;
}

export interface ProcessStateChangedPayload extends ProcessRef {
  from: ProcessState;
  to: ProcessState;
}

export interface ProcessSignalledPayload extends ProcessRef {
  signal: string;
  /** False when the target pid did not exist / could not be signalled. */
  delivered: boolean;
}

export type ProcessReapedPayload = ProcessRef;

export interface ProcessPriorityChangedPayload extends ProcessRef {
  oldNice: number;
  newNice: number;
}

// ── Service lifecycle ───────────────────────────────────────────────────

export interface ServiceLifecyclePayload extends ServiceRef {
  state: ServiceState;
  mainPid?: number;
  type: string;
}

export interface ServiceStateChangedPayload extends ServiceRef {
  from: ServiceState;
  to: ServiceState;
}

export interface ServiceEnablementChangedPayload extends ServiceRef {
  enabled: EnabledState;
}

export interface ServiceFailedPayload extends ServiceRef {
  reason: string;
}

// ── Discriminated union ────────────────────────────────────────────────

export type LinuxProcessServiceDomainEvent =
  | { topic: 'linux.process.spawned'; payload: ProcessSpawnedPayload }
  | { topic: 'linux.process.exited'; payload: ProcessExitedPayload }
  | { topic: 'linux.process.state-changed'; payload: ProcessStateChangedPayload }
  | { topic: 'linux.process.signalled'; payload: ProcessSignalledPayload }
  | { topic: 'linux.process.reaped'; payload: ProcessReapedPayload }
  | { topic: 'linux.process.priority-changed'; payload: ProcessPriorityChangedPayload }
  | { topic: 'linux.service.started'; payload: ServiceLifecyclePayload }
  | { topic: 'linux.service.stopped'; payload: ServiceLifecyclePayload }
  | { topic: 'linux.service.restarted'; payload: ServiceLifecyclePayload }
  | { topic: 'linux.service.reloaded'; payload: ServiceLifecyclePayload }
  | { topic: 'linux.service.state-changed'; payload: ServiceStateChangedPayload }
  | { topic: 'linux.service.enabled'; payload: ServiceEnablementChangedPayload }
  | { topic: 'linux.service.disabled'; payload: ServiceEnablementChangedPayload }
  | { topic: 'linux.service.masked'; payload: ServiceEnablementChangedPayload }
  | { topic: 'linux.service.unmasked'; payload: ServiceEnablementChangedPayload }
  | { topic: 'linux.service.failed'; payload: ServiceFailedPayload };
