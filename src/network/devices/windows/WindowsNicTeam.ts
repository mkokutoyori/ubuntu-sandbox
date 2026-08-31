import type { LoadBalanceMethod } from '@/network/lacp/loadBalance';

export const TEAMING_MODES = ['Static', 'SwitchIndependent', 'LACP'] as const;
export type TeamingMode = typeof TEAMING_MODES[number];

export const LB_ALGORITHMS = [
  'TransportPorts', 'IPAddresses', 'MacAddresses', 'HyperVPort', 'Dynamic',
] as const;
export type LbAlgorithm = typeof LB_ALGORITHMS[number];

export const LACP_TIMERS = ['Slow', 'Fast'] as const;
export type LacpTimer = typeof LACP_TIMERS[number];

export const ADMIN_MODES = ['Active', 'Standby'] as const;
export type AdminMode = typeof ADMIN_MODES[number];

export type TeamStatus = 'Up' | 'Down' | 'Degraded';
export type MemberStatus = 'Active' | 'Standby' | 'Failed';

export interface TeamMember {
  name: string;
  adminMode: AdminMode;
}

export interface NicTeam {
  name: string;
  members: TeamMember[];
  teamNic: string;
  teamingMode: TeamingMode;
  loadBalancingAlgorithm: LbAlgorithm;
  lacpTimer: LacpTimer;
}

export function normaliseTeamingMode(value: string): TeamingMode | null {
  const found = TEAMING_MODES.find(m => m.toLowerCase() === value.toLowerCase());
  return found ?? null;
}

export function normaliseLbAlgorithm(value: string): LbAlgorithm | null {
  const found = LB_ALGORITHMS.find(a => a.toLowerCase() === value.toLowerCase());
  return found ?? null;
}

export function normaliseLacpTimer(value: string): LacpTimer | null {
  const found = LACP_TIMERS.find(t => t.toLowerCase() === value.toLowerCase());
  return found ?? null;
}

export function normaliseAdminMode(value: string): AdminMode | null {
  const found = ADMIN_MODES.find(m => m.toLowerCase() === value.toLowerCase());
  return found ?? null;
}

export function teamStatus(
  members: readonly TeamMember[], up: (member: string) => boolean,
): TeamStatus {
  const actifs = members.filter(m => m.adminMode === 'Active');
  const vivants = actifs.filter(m => up(m.name));
  if (vivants.length === 0) return 'Down';
  return vivants.length === actifs.length ? 'Up' : 'Degraded';
}

export function memberStatus(
  member: TeamMember, up: boolean, bundled: boolean, mode: TeamingMode,
): MemberStatus {
  if (!up) return 'Failed';
  if (member.adminMode === 'Standby') return 'Standby';
  if (mode === 'LACP' && !bundled) return 'Failed';
  return 'Active';
}

export function defaultTeam(name: string, members: readonly string[]): NicTeam {
  return {
    name,
    members: members.map(m => ({ name: m, adminMode: 'Active' as AdminMode })),
    teamNic: name,
    teamingMode: 'SwitchIndependent',
    loadBalancingAlgorithm: 'Dynamic',
    lacpTimer: 'Slow',
  };
}

export function lbAlgorithmToLoadBalance(algo: LbAlgorithm): LoadBalanceMethod {
  switch (algo) {
    case 'TransportPorts':
      return 'src-dst-port';
    case 'IPAddresses':
    case 'Dynamic':
      return 'src-dst-ip';
    default:
      return 'src-dst-mac';
  }
}

export function memberFailureReason(
  member: TeamMember, up: boolean, bundled: boolean, mode: TeamingMode,
): string {
  if (member.adminMode === 'Standby') return 'AdministrativeDecision';
  if (!up) return 'PhysicalMediaDisconnected';
  if (mode === 'LACP' && !bundled) return 'LacpNegotiationIssue';
  return 'NoFailure';
}
