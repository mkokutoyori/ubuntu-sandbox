export interface FhrpTrackView {
  target: string;
  decrement: number;
}

export interface HsrpGroupView {
  group: number;
  version?: 1 | 2;
  vip: string | null;
  secondary?: readonly string[];
  priority: number;
  preempt: boolean;
  preemptDelaySec?: number;
  helloSec: number;
  holdSec: number;
  authText?: string;
  authMd5?: string;
  name?: string;
  tracks: readonly FhrpTrackView[];
}

export interface VrrpGroupView {
  group: number;
  vip: string | null;
  priority: number;
  preempt: boolean;
  preemptDelaySec?: number;
  advertiseSec: number;
  authMd5?: string;
  description?: string;
  tracks: readonly FhrpTrackView[];
}

export interface GlbpGroupView {
  group: number;
  vip: string | null;
  priority: number;
  preempt: boolean;
  preemptDelaySec?: number;
  weighting: number;
  weightingLower?: number;
  weightingUpper?: number;
  loadBalancing: string;
  name?: string;
  authMd5?: string;
  tracks: readonly FhrpTrackView[];
}

export interface FhrpInterfaceView {
  hsrp: readonly HsrpGroupView[];
  vrrp: readonly VrrpGroupView[];
  glbp: readonly GlbpGroupView[];
}

export const HSRP_DEFAULT_PRIORITY = 100;
export const HSRP_DEFAULT_HELLO_SEC = 3;
export const HSRP_DEFAULT_HOLD_SEC = 10;
export const HSRP_DEFAULT_AUTH_TEXT = 'cisco';
export const VRRP_DEFAULT_PRIORITY = 100;
export const VRRP_DEFAULT_ADVERTISE_SEC = 1;
export const VRRP_DEFAULT_PREEMPT = true;
export const GLBP_DEFAULT_PRIORITY = 100;
export const GLBP_DEFAULT_WEIGHTING = 100;
export const GLBP_DEFAULT_LOAD_BALANCING = 'round-robin';
export const FHRP_DEFAULT_TRACK_DECREMENT = 10;

function trackTail(track: FhrpTrackView): string {
  return track.decrement === FHRP_DEFAULT_TRACK_DECREMENT
    ? '' : ` decrement ${track.decrement}`;
}

function preemptLine(mot: string, group: number, delaySec?: number): string {
  return delaySec === undefined || delaySec <= 0
    ? ` ${mot} ${group} preempt`
    : ` ${mot} ${group} preempt delay minimum ${delaySec}`;
}

function aUnDelai(delaySec?: number): boolean {
  return delaySec !== undefined && delaySec > 0;
}

function hsrpLines(groups: readonly HsrpGroupView[]): string[] {
  const out: string[] = [];
  if (groups.some((g) => g.version === 2)) out.push(' standby version 2');
  for (const g of groups) {
    if (g.vip) out.push(` standby ${g.group} ip ${g.vip}`);
    for (const s of g.secondary ?? []) out.push(` standby ${g.group} ip ${s} secondary`);
    if (g.priority !== HSRP_DEFAULT_PRIORITY) {
      out.push(` standby ${g.group} priority ${g.priority}`);
    }
    if (g.preempt) out.push(preemptLine('standby', g.group, g.preemptDelaySec));
    if (g.helloSec !== HSRP_DEFAULT_HELLO_SEC || g.holdSec !== HSRP_DEFAULT_HOLD_SEC) {
      out.push(` standby ${g.group} timers ${g.helloSec} ${g.holdSec}`);
    }
    if (g.authMd5) out.push(` standby ${g.group} authentication md5 key-string ${g.authMd5}`);
    else if (g.authText !== undefined && g.authText !== HSRP_DEFAULT_AUTH_TEXT) {
      out.push(` standby ${g.group} authentication text ${g.authText}`);
    }
    if (g.name) out.push(` standby ${g.group} name ${g.name}`);
    for (const t of g.tracks) {
      out.push(` standby ${g.group} track ${t.target}${trackTail(t)}`);
    }
  }
  return out;
}

function vrrpLines(groups: readonly VrrpGroupView[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g.vip) out.push(` vrrp ${g.group} ip ${g.vip}`);
    if (g.priority !== VRRP_DEFAULT_PRIORITY) {
      out.push(` vrrp ${g.group} priority ${g.priority}`);
    }
    if (g.preempt !== VRRP_DEFAULT_PREEMPT) {
      out.push(g.preempt ? preemptLine('vrrp', g.group, g.preemptDelaySec)
        : ` no vrrp ${g.group} preempt`);
    } else if (g.preempt && aUnDelai(g.preemptDelaySec)) {
      out.push(preemptLine('vrrp', g.group, g.preemptDelaySec));
    }
    if (g.advertiseSec !== VRRP_DEFAULT_ADVERTISE_SEC) {
      out.push(` vrrp ${g.group} timers advertise ${g.advertiseSec}`);
    }
    if (g.authMd5) out.push(` vrrp ${g.group} authentication md5 key-string ${g.authMd5}`);
    if (g.description) out.push(` vrrp ${g.group} description ${g.description}`);
    for (const t of g.tracks) {
      out.push(` vrrp ${g.group} track ${t.target}${trackTail(t)}`);
    }
  }
  return out;
}

function glbpLines(groups: readonly GlbpGroupView[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g.vip) out.push(` glbp ${g.group} ip ${g.vip}`);
    if (g.priority !== GLBP_DEFAULT_PRIORITY) {
      out.push(` glbp ${g.group} priority ${g.priority}`);
    }
    if (g.preempt) out.push(preemptLine('glbp', g.group, g.preemptDelaySec));
    if (g.weighting !== GLBP_DEFAULT_WEIGHTING
      || g.weightingLower !== undefined || g.weightingUpper !== undefined) {
      out.push(` glbp ${g.group} weighting ${g.weighting}`
        + (g.weightingLower === undefined ? '' : ` lower ${g.weightingLower}`)
        + (g.weightingUpper === undefined ? '' : ` upper ${g.weightingUpper}`));
    }
    if (g.loadBalancing !== GLBP_DEFAULT_LOAD_BALANCING) {
      out.push(` glbp ${g.group} load-balancing ${g.loadBalancing}`);
    }
    if (g.authMd5) out.push(` glbp ${g.group} authentication md5 key-string ${g.authMd5}`);
    if (g.name) out.push(` glbp ${g.group} name ${g.name}`);
    for (const t of g.tracks) {
      out.push(` glbp ${g.group} weighting track ${t.target}${trackTail(t)}`);
    }
  }
  return out;
}

export function fhrpRunningConfigLines(view: FhrpInterfaceView): string[] {
  return [...vrrpLines(view.vrrp), ...hsrpLines(view.hsrp), ...glbpLines(view.glbp)];
}
