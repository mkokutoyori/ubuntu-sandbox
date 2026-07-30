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

/** A service's hosting process died out from under it (not a graceful stop). */
export interface WindowsServiceCrashedPayload extends WindowsDeviceRef {
  serviceName: string;
  displayName: string;
  /** How many times this service has crashed within the current reset window. */
  failureCount: number;
}

/** `sc config <name> obj= "<account>"` changed a service's logon account. */
export interface WindowsServiceAccountChangedPayload extends WindowsDeviceRef {
  serviceName: string;
  displayName: string;
  previousAccount: string;
  newAccount: string;
  /** The username that made the change (for 4657 audit attribution). */
  changedBy: string;
}

/** A `run` recovery action (`sc failure ... actions= run/...`) has fired. */
export interface WindowsServiceRecoveryRunPayload extends WindowsDeviceRef {
  serviceName: string;
  command: string;
  /** Failure rank (1 = first failure) that selected this action. */
  rank: number;
}

/** A `reboot` recovery action fired — suppressed in the simulator, logged instead. */
export interface WindowsServiceRecoveryCriticalPayload extends WindowsDeviceRef {
  serviceName: string;
  displayName: string;
  rank: number;
}

/** A new service was installed (`New-Service` / `sc create`). */
export interface WindowsServiceCreatedPayload extends WindowsDeviceRef {
  serviceName: string;
  displayName: string;
  binaryPath: string;
  account: string;
  /** The username that ran the install (for 4697 audit attribution). */
  installedBy: string;
}

// ─── Account lifecycle ──────────────────────────────────────────────────

/** The kind of change applied to a local account. */
export type WindowsAccountChange =
  | 'created' | 'deleted' | 'password-reset' | 'enabled' | 'disabled' | 'modified' | 'locked-out';

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
  /** PID du parent — le `ProcessId` de 4688, distinct de `NewProcessId`. */
  ppid?: number;
  /** Nom du parent, quand il tourne encore (`ParentProcessName`). */
  parentName?: string;
  /** Compte sous lequel le processus s'exécute (`SubjectUserName`). */
  owner?: string;
  /**
   * Ligne de commande complète. Windows ne la journalise dans 4688 que
   * si `ProcessCreationIncludeCmdLine_Enabled` vaut 1 — c'est
   * précisément ce réglage qui rend une obfuscation `-EncodedCommand`
   * visible, et sans lui le champ n'existe pas.
   */
  commandLine?: string;
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
  | { topic: 'windows.service.crashed'; payload: WindowsServiceCrashedPayload }
  | { topic: 'windows.service.created'; payload: WindowsServiceCreatedPayload }
  | { topic: 'windows.service.account-changed'; payload: WindowsServiceAccountChangedPayload }
  | { topic: 'windows.filesystem.acl-changed'; payload: WindowsFileAclChangedPayload }
  | { topic: 'windows.service.recovery-run'; payload: WindowsServiceRecoveryRunPayload }
  | { topic: 'windows.service.recovery-critical'; payload: WindowsServiceRecoveryCriticalPayload }
  | { topic: 'windows.account.changed'; payload: WindowsAccountChangedPayload }
  | { topic: 'windows.account.logon'; payload: WindowsLogonEventPayload }
  | { topic: 'windows.account.logoff'; payload: WindowsLogoffEventPayload }
  | { topic: 'windows.group.created'; payload: WindowsGroupEventPayload }
  | { topic: 'windows.group.deleted'; payload: WindowsGroupEventPayload }
  | { topic: 'windows.group.membership-changed'; payload: WindowsGroupMemberEventPayload }
  | { topic: 'windows.process.started'; payload: WindowsProcessEventPayload }
  | { topic: 'windows.process.stopped'; payload: WindowsProcessEventPayload }
  | { topic: 'windows.portproxy.added'; payload: WindowsPortProxyEventPayload }
  | { topic: 'windows.portproxy.removed'; payload: WindowsPortProxyEventPayload }
  | { topic: 'windows.firewall.drop'; payload: WindowsFirewallDropPayload };

/** `Set-Acl`/`icacls` changed the discretionary ACL on a filesystem object. */
export interface WindowsFileAclChangedPayload extends WindowsDeviceRef {
  path: string;
  identity: string;
  permissions: string;
  /** The username that made the change (for 4670 audit attribution). */
  changedBy: string;
}

export interface WindowsFirewallDropPayload {
  deviceId: string;
  hostname: string;
  ruleName: string;
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  protocol: string;
  direction: 'Inbound' | 'Outbound';
}
