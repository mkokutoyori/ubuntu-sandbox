/**
 * Windows device — reactive event taxonomy.
 *
 * Mirrors the Linux taxonomy: the Windows managers (service controller,
 * account database, process table) publish deviceId-scoped domain events on
 * the central `EventBus` whenever they mutate state. Reactive consumers —
 * the Security / System event-log projections, the socket-table coherence
 * layer — subscribe and keep their derived views coherent.
 *
 * Payloads are plain serialisable records and deliberately carry more
 * context than today's consumers read (`sid`, `displayName`, `logonType`),
 * because an Event Viewer panel, a logon-session tracker or a security
 * dashboard are all natural next consumers of this stream.
 */

// ─── Identity ───────────────────────────────────────────────────────────

export interface WindowsDeviceRef {
  deviceId: string;
}

// ─── Service lifecycle ──────────────────────────────────────────────────

export interface WindowsServiceEventPayload extends WindowsDeviceRef {
  /** Service short name (`sc` key). */
  serviceName: string;
  /** Human-readable display name. */
  displayName: string;
  /** True once the service has entered the running state. */
  running: boolean;
}

// ─── Account lifecycle ──────────────────────────────────────────────────

/** The kind of change applied to a local account. */
export type WindowsAccountChange =
  | 'created' | 'deleted' | 'password-reset' | 'enabled' | 'disabled' | 'modified';

export interface WindowsAccountChangedPayload extends WindowsDeviceRef {
  account: string;
  change: WindowsAccountChange;
}

export interface WindowsLogonEventPayload extends WindowsDeviceRef {
  account: string;
  /** True for a successful authentication, false for a failed one. */
  success: boolean;
  /** Windows logon type (2 = interactive, 3 = network, 10 = RDP, …). */
  logonType: number;
}

export interface WindowsLogoffEventPayload extends WindowsDeviceRef {
  account: string;
  /** Windows logon type of the session that ended (mirrors the 4624 it pairs with). */
  logonType: number;
}

// ─── Group lifecycle ────────────────────────────────────────────────────

export interface WindowsGroupEventPayload extends WindowsDeviceRef {
  group: string;
}

export interface WindowsGroupMemberEventPayload extends WindowsGroupEventPayload {
  member: string;
  /** True when the member was added, false when removed. */
  added: boolean;
}

// ─── Process lifecycle ──────────────────────────────────────────────────

export interface WindowsProcessEventPayload extends WindowsDeviceRef {
  pid: number;
  name: string;
  /** True for a spawn, false for a termination. */
  started: boolean;
}

// ─── Port-proxy lifecycle (netsh interface portproxy) ───────────────────

export interface WindowsPortProxyEventPayload extends WindowsDeviceRef {
  /** Address family pairing: v4tov4 / v4tov6 / v6tov4 / v6tov6. */
  protocol: string;
  /** Address the proxy listens on. */
  listenAddress: string;
  /** Port the proxy listens on. */
  listenPort: number;
  /** Address connections are forwarded to. */
  connectAddress: string;
  /** Port connections are forwarded to. */
  connectPort: number;
}

// ─── Discriminated union ────────────────────────────────────────────────

export type WindowsDomainEvent =
  | { topic: 'windows.service.started'; payload: WindowsServiceEventPayload }
  | { topic: 'windows.service.stopped'; payload: WindowsServiceEventPayload }
  | { topic: 'windows.account.changed'; payload: WindowsAccountChangedPayload }
  | { topic: 'windows.account.logon'; payload: WindowsLogonEventPayload }
  | { topic: 'windows.account.logoff'; payload: WindowsLogoffEventPayload }
  | { topic: 'windows.group.created'; payload: WindowsGroupEventPayload }
  | { topic: 'windows.group.deleted'; payload: WindowsGroupEventPayload }
  | { topic: 'windows.group.membership-changed'; payload: WindowsGroupMemberEventPayload }
  | { topic: 'windows.process.started'; payload: WindowsProcessEventPayload }
  | { topic: 'windows.process.stopped'; payload: WindowsProcessEventPayload }
  | { topic: 'windows.portproxy.added'; payload: WindowsPortProxyEventPayload }
  | { topic: 'windows.portproxy.removed'; payload: WindowsPortProxyEventPayload };
