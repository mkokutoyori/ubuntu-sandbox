import type { NhrpService } from './NhrpService';

export type DmvpnRole = 'hub' | 'spoke';
export type DmvpnPhase = 1 | 2 | 3;
export type DmvpnTunnelState = 'IKE' | 'IPSEC' | 'NHRP' | 'UP';

export interface DmvpnSession {
  ifName: string;
  peerNbmaAddress: string;
  peerTunnelAddress: string;
  role: DmvpnRole;
  state: DmvpnTunnelState;
  attribute: string;
  pktsSent: number;
  pktsRcvd: number;
  bytesSent: number;
  bytesRcvd: number;
  uptimeMs: number;
  createdAtMs: number;
}

export interface DmvpnTunnelProfile {
  ifName: string;
  role: DmvpnRole;
  phase: DmvpnPhase;
  nbmaAddress?: string;
  tunnelAddress?: string;
}

export class DmvpnService {
  private readonly profiles: Map<string, DmvpnTunnelProfile> = new Map();
  private readonly sessions: DmvpnSession[] = [];
  private readonly nhrp: NhrpService;

  constructor(nhrp: NhrpService) {
    this.nhrp = nhrp;
  }

  registerTunnel(profile: DmvpnTunnelProfile): void {
    this.profiles.set(profile.ifName, profile);
  }

  removeTunnel(ifName: string): void {
    this.profiles.delete(ifName);
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      if (this.sessions[i].ifName === ifName) this.sessions.splice(i, 1);
    }
  }

  registerSession(s: Omit<DmvpnSession, 'createdAtMs' | 'uptimeMs' | 'pktsSent' | 'pktsRcvd' | 'bytesSent' | 'bytesRcvd'>): DmvpnSession {
    const session: DmvpnSession = {
      ...s,
      pktsSent: 0, pktsRcvd: 0, bytesSent: 0, bytesRcvd: 0,
      uptimeMs: 0,
      createdAtMs: Date.now(),
    };
    this.sessions.push(session);
    return session;
  }

  listProfiles(): readonly DmvpnTunnelProfile[] { return [...this.profiles.values()]; }
  listSessions(): readonly DmvpnSession[] { return [...this.sessions]; }

  formatSessions(detail: boolean): string {
    if (this.sessions.length === 0 && this.profiles.size === 0) return 'No DMVPN sessions';

    const lines: string[] = [];
    for (const profile of this.profiles.values()) {
      lines.push(`Legend: Attrb --> S - Static, D - Dynamic, I - Incomplete`);
      lines.push(`        N - NATed, L - Local, X - No Socket`);
      lines.push(``);
      lines.push(`Interface: ${profile.ifName}, IPv4 NHRP Details`);
      lines.push(`Type: ${profile.role === 'hub' ? 'Hub' : 'Spoke'}, NHRP Peers: ${this.sessions.filter(s => s.ifName === profile.ifName).length}, Phase: ${profile.phase}`);
      lines.push(``);
      lines.push(` # Ent  Peer NBMA Addr    Peer Tunnel Add State  UpDn Tm  Attrb`);
      lines.push(` ----- --------------- --------------- ----- -------- -----`);
      const sessions = this.sessions.filter(s => s.ifName === profile.ifName);
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const upTime = formatHms(Date.now() - s.createdAtMs);
        lines.push(`     ${(i + 1).toString().padStart(2, ' ')} ${s.peerNbmaAddress.padEnd(15)} ${s.peerTunnelAddress.padEnd(15)} ${s.state.padEnd(5)} ${upTime}  ${s.attribute}`);
        if (detail) {
          lines.push(`   Type: ${profile.role === 'hub' ? 'Hub' : 'Spoke'}, NHS Status: E --> 1`);
          lines.push(`   IKE: ${s.state === 'IKE' ? 'pending' : 'established'}`);
          lines.push(`   IPSEC: ${s.state === 'IKE' ? 'down' : 'up'}`);
          lines.push(`   pkts: snt: ${s.pktsSent} rcv: ${s.pktsRcvd}  bytes: snt: ${s.bytesSent} rcv: ${s.bytesRcvd}`);
        }
      }
    }
    if (lines.length === 0) return 'No DMVPN sessions';
    void this.nhrp;
    return lines.join('\n');
  }

  asRunningConfigInterface(ifName: string): string[] {
    const profile = this.profiles.get(ifName);
    if (!profile) return [];
    const lines: string[] = [];
    return lines;
  }
}

function formatHms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function pad(n: number): string { return n.toString().padStart(2, '0'); }
