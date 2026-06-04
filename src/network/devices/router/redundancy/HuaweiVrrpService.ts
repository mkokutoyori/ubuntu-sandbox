export type VrrpAuthMode = 'simple' | 'md5' | 'none';

export interface VrrpTrackEntry {
  kind: 'interface' | 'route' | 'bfd';
  target: string;
  reduced: number;
  args?: string[];
}

export interface VrrpGroup {
  vrid: number;
  ifName: string;
  virtualIps: string[];
  priority: number;
  preemptMode: boolean;
  preemptDelaySec: number;
  description: string;
  advertiseTimerSec: number;
  authMode: VrrpAuthMode;
  authKey?: string;
  isAdminVrrp: boolean;
  bindingAdminVrid?: number;
  trackEntries: VrrpTrackEntry[];
  rawLines: string[];
  state: 'Initialize' | 'Backup' | 'Master';
}

export class HuaweiVrrpService {
  private readonly groups: Map<string, VrrpGroup> = new Map();
  private readonly adminGroups: Map<number, VrrpGroup> = new Map();

  private key(iface: string, vrid: number): string { return `${iface}::${vrid}`; }

  ensure(iface: string, vrid: number): VrrpGroup {
    const k = this.key(iface, vrid);
    let g = this.groups.get(k);
    if (!g) {
      g = {
        vrid, ifName: iface,
        virtualIps: [],
        priority: 100,
        preemptMode: true,
        preemptDelaySec: 0,
        description: '',
        advertiseTimerSec: 1,
        authMode: 'none',
        isAdminVrrp: false,
        trackEntries: [],
        rawLines: [],
        state: 'Initialize',
      };
      this.groups.set(k, g);
    }
    return g;
  }

  ensureAdmin(vrid: number): VrrpGroup {
    let g = this.adminGroups.get(vrid);
    if (!g) {
      g = {
        vrid, ifName: '',
        virtualIps: [],
        priority: 100,
        preemptMode: true,
        preemptDelaySec: 0,
        description: '',
        advertiseTimerSec: 1,
        authMode: 'none',
        isAdminVrrp: true,
        trackEntries: [],
        rawLines: [],
        state: 'Initialize',
      };
      this.adminGroups.set(vrid, g);
    }
    return g;
  }

  remove(iface: string, vrid: number): boolean {
    return this.groups.delete(this.key(iface, vrid));
  }

  get(iface: string, vrid: number): VrrpGroup | undefined {
    return this.groups.get(this.key(iface, vrid));
  }
  list(): readonly VrrpGroup[] { return [...this.groups.values()]; }
  listAdmin(): readonly VrrpGroup[] { return [...this.adminGroups.values()]; }

  asInterfaceRunningConfigLines(iface: string): string[] {
    const lines: string[] = [];
    for (const g of this.groups.values()) {
      if (g.ifName !== iface) continue;
      for (const ip of g.virtualIps) lines.push(` vrrp vrid ${g.vrid} virtual-ip ${ip}`);
      if (g.priority !== 100) lines.push(` vrrp vrid ${g.vrid} priority ${g.priority}`);
      if (g.advertiseTimerSec !== 1) lines.push(` vrrp vrid ${g.vrid} timer advertise ${g.advertiseTimerSec}`);
      if (g.preemptDelaySec > 0) lines.push(` vrrp vrid ${g.vrid} preempt-mode timer delay ${g.preemptDelaySec}`);
      else if (!g.preemptMode) lines.push(` undo vrrp vrid ${g.vrid} preempt-mode`);
      if (g.description) lines.push(` vrrp vrid ${g.vrid} description ${g.description}`);
      if (g.authMode !== 'none') lines.push(` vrrp vrid ${g.vrid} authentication-mode ${g.authMode}${g.authKey ? ' cipher ' + g.authKey : ''}`);
      if (g.bindingAdminVrid !== undefined) lines.push(` vrrp vrid ${g.vrid} track admin-vrrp interface ${iface} vrid ${g.bindingAdminVrid}`);
      for (const t of g.trackEntries) {
        if (t.kind === 'interface') lines.push(` vrrp vrid ${g.vrid} track interface ${t.target} reduced ${t.reduced}`);
        else if (t.kind === 'route') lines.push(` vrrp vrid ${g.vrid} track ip route ${t.target} reduced ${t.reduced}`);
        else if (t.kind === 'bfd') lines.push(` vrrp vrid ${g.vrid} track bfd-session ${t.target} reduced ${t.reduced}`);
      }
      for (const r of g.rawLines) lines.push(` ${r}`);
    }
    return lines;
  }
}
