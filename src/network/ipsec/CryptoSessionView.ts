export type CryptoSessionMode = 'plain' | 'brief' | 'detail';

export interface SessionFlow {
  permit: string;
  activeSas: number;
  origin: string;
  decapsulated: number;
  decapsulationDrops: number;
  encapsulated: number;
  encapsulationDrops: number;
  remainingKilobytes: number;
  remainingSeconds: number;
}

export interface SessionIke {
  local: string;
  remote: string;
  active: boolean;
  connId: number;
  remainingSeconds: number;
  capabilities: string;
}

export interface CryptoSession {
  peer: string;
  port: number;
  interfaceName: string;
  phase1Id: string;
  uptimeSeconds: number;
  ike: SessionIke[];
  flows: SessionFlow[];
}

const INTERFACE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['GigabitEthernet', 'Gi'], ['FastEthernet', 'Fa'], ['TenGigabitEthernet', 'Te'], ['Ethernet', 'Et'],
  ['Serial', 'Se'], ['Tunnel', 'Tu'], ['Loopback', 'Lo'], ['Virtual-Access', 'Vi'],
];

function abbreviated(name: string): string {
  for (const [long, short] of INTERFACE_PREFIXES) if (name.startsWith(long)) return short + name.slice(long.length);
  return name;
}

export function sessionStatus(session: CryptoSession): string {
  const hasIke = session.ike.some((sa) => sa.active);
  if (hasIke && session.flows.length > 0) return 'UP-ACTIVE';
  if (hasIke) return 'UP-IDLE';
  if (session.flows.length > 0) return 'UP-NO-IKE';
  return 'DOWN';
}

function statusCode(session: CryptoSession): string {
  const status = sessionStatus(session);
  if (status === 'UP-ACTIVE') return 'UA';
  if (status === 'UP-IDLE') return 'UI';
  if (status === 'UP-NO-IKE') return 'UK';
  return 'D';
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function brief(sessions: readonly CryptoSession[]): string {
  const lines = [
    'Status: A- Active, U - Up, D - Down, I - Idle, S - Standby, N - Negotiating',
    '        K - No IKE',
    'ivrf = (none)',
    `${'Peer'.padEnd(20)}${'I/F'.padEnd(13)}${'Username'.padEnd(17)}${'Group/Phase1_id'.padEnd(25)}${'Uptime'.padEnd(9)}Status`,
  ];
  for (const session of sessions) {
    lines.push(`${session.peer.padEnd(20)}${abbreviated(session.interfaceName).padEnd(13)}${'-'.padEnd(17)}`
      + `${session.phase1Id.padEnd(25)}${clock(session.uptimeSeconds).padEnd(9)}${statusCode(session)}`);
  }
  return lines.join('\n');
}

function full(sessions: readonly CryptoSession[], detail: boolean): string {
  const lines = ['Crypto session current status', ''];
  if (detail) lines.push('Code: C - IKE Configuration mode, D - Dead Peer Detection', 'K - Keepalives, N - NAT-traversal, X - IKE Extended Authentication', '');
  sessions.forEach((session, index) => {
    if (index > 0) lines.push('');
    lines.push(`Interface: ${session.interfaceName}`);
    if (detail) lines.push(`Uptime: ${clock(session.uptimeSeconds)}`);
    lines.push(`Session status: ${sessionStatus(session)}`);
    lines.push(detail
      ? `Peer: ${session.peer} port ${session.port} fvrf: (none) ivrf: (none)`
      : `Peer: ${session.peer} port ${session.port}`);
    if (detail) lines.push(`      Phase1_id: ${session.phase1Id}`, '      Desc: (none)');
    for (const ike of session.ike) {
      lines.push(`  IKE SA: local ${ike.local}/${session.port} remote ${ike.remote}/${session.port} ${ike.active ? 'Active' : 'Inactive'}`);
      if (detail) lines.push(`          Capabilities:${ike.capabilities} connid:${ike.connId} lifetime:${clock(ike.remainingSeconds)}`);
    }
    for (const flow of session.flows) {
      lines.push(`  IPSEC FLOW: ${flow.permit}`);
      lines.push(`        Active SAs: ${flow.activeSas}, origin: ${flow.origin}`);
      if (detail) {
        lines.push(`        Inbound:  #pkts dec'ed ${flow.decapsulated} drop ${flow.decapsulationDrops} life (KB/Sec) ${flow.remainingKilobytes}/${flow.remainingSeconds}`);
        lines.push(`        Outbound: #pkts enc'ed ${flow.encapsulated} drop ${flow.encapsulationDrops} life (KB/Sec) ${flow.remainingKilobytes}/${flow.remainingSeconds}`);
      }
    }
  });
  return lines.join('\n');
}

export function renderCryptoSessions(sessions: readonly CryptoSession[], mode: CryptoSessionMode): string {
  if (sessions.length === 0) return mode === 'brief' ? brief([]) : '';
  if (mode === 'brief') return brief(sessions);
  return full(sessions, mode === 'detail');
}
