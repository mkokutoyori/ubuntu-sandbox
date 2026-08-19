export type HaMode = 'standalone' | 'a-a' | 'a-p';

export type HaRole = 'standalone' | 'master' | 'slave';

export interface HaHeartbeatDevice {
  readonly iface: string;
  readonly priority: number;
}

export interface HaConfiguration {
  readonly mode: HaMode;
  readonly groupId: number;
  readonly groupName: string;
  readonly password: string;
  readonly priority: number;
  readonly override: boolean;
  readonly sessionPickup: boolean;
  readonly heartbeatDevices: readonly HaHeartbeatDevice[];
  readonly monitored: readonly string[];
  readonly heartbeatIntervalTicks: number;
  readonly lostThreshold: number;
}

export const HA_DEFAULTS: HaConfiguration = Object.freeze({
  mode: 'standalone',
  groupId: 0,
  groupName: '',
  password: '',
  priority: 128,
  override: false,
  sessionPickup: false,
  heartbeatDevices: Object.freeze([]),
  monitored: Object.freeze([]),
  heartbeatIntervalTicks: 2,
  lostThreshold: 6,
});

export interface HaSyncedSession {
  readonly key: string;
  readonly ingressZone: string;
  readonly egressZone: string;
  readonly ingressInterface: string;
  readonly egressInterface: string;
  readonly timeoutSec: number;
  readonly policyId?: string;
}

export interface HaHeartbeat {
  readonly type: 'fgcp-heartbeat';
  readonly groupId: number;
  readonly groupName: string;
  readonly passwordDigest: string;
  readonly serial: string;
  readonly priority: number;
  readonly override: boolean;
  readonly monitoredUp: number;
  readonly uptimeMs: number;
  readonly role: HaRole;
  readonly configurationDigest: string;
  readonly configuration: string;
  readonly sessionPickup: boolean;
  readonly steppingDown: boolean;
  readonly sessions: readonly HaSyncedSession[];
}

export interface HaPeer {
  readonly serial: string;
  priority: number;
  override: boolean;
  monitoredUp: number;
  uptimeMs: number;
  role: HaRole;
  steppingDown: boolean;
  configurationDigest: string;
  silentTicks: number;
  lastSeenAt: number;
}

export interface HaCandidate {
  readonly serial: string;
  readonly priority: number;
  readonly monitoredUp: number;
  readonly uptimeMs: number;
}

export type HaElectionReason =
  | 'only-member'
  | 'monitored-interfaces'
  | 'priority'
  | 'uptime'
  | 'serial';

export interface HaElection {
  readonly winner: string;
  readonly reason: HaElectionReason;
}

const UPTIME_GRANULARITY_MS = 5 * 60 * 1000;

export function electPrimary(candidates: readonly HaCandidate[]): HaElection {
  if (candidates.length === 1) {
    return { winner: candidates[0].serial, reason: 'only-member' };
  }

  const sorted = [...candidates].sort(compareCandidates);
  return { winner: sorted[0].serial, reason: reasonAgainst(sorted[0], sorted[1]) };
}

function compareCandidates(left: HaCandidate, right: HaCandidate): number {
  if (left.monitoredUp !== right.monitoredUp) return right.monitoredUp - left.monitoredUp;
  if (left.priority !== right.priority) return right.priority - left.priority;

  const leftSteps = Math.floor(left.uptimeMs / UPTIME_GRANULARITY_MS);
  const rightSteps = Math.floor(right.uptimeMs / UPTIME_GRANULARITY_MS);
  if (leftSteps !== rightSteps) return rightSteps - leftSteps;

  return left.serial < right.serial ? 1 : -1;
}

function reasonAgainst(winner: HaCandidate, runnerUp: HaCandidate): HaElectionReason {
  if (winner.monitoredUp !== runnerUp.monitoredUp) return 'monitored-interfaces';
  if (winner.priority !== runnerUp.priority) return 'priority';

  const winnerSteps = Math.floor(winner.uptimeMs / UPTIME_GRANULARITY_MS);
  const runnerSteps = Math.floor(runnerUp.uptimeMs / UPTIME_GRANULARITY_MS);
  if (winnerSteps !== runnerSteps) return 'uptime';

  return 'serial';
}

export function electionSentence(serial: string, reason: HaElectionReason): string {
  const because: Record<HaElectionReason, string> = {
    'only-member': "it's the only member in the cluster",
    'monitored-interfaces': 'it has the least value of link-failure',
    priority: 'its priority is larger than peer member',
    uptime: 'it has the largest value of uptime',
    serial: 'it has the largest value of serial number',
  };
  return `${serial} is selected as the master because ${because[reason]}.`;
}
