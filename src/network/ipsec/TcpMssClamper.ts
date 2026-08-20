const OUTER_IP_HEADER_BYTES = 20;
const ESP_OVERHEAD_BYTES = 50;
const AH_OVERHEAD_BYTES = 24;
const MIN_IPV4_MTU = 576;
const TCP_IP_HEADER_BYTES = 40;

export interface IpsecOverheadInput {
  readonly hasESP: boolean;
  readonly hasAH: boolean;
}

export function computeIpsecOverheadBytes(cfg: IpsecOverheadInput): number {
  let overhead = OUTER_IP_HEADER_BYTES;
  if (cfg.hasESP) overhead += ESP_OVERHEAD_BYTES;
  if (cfg.hasAH) overhead += AH_OVERHEAD_BYTES;
  return overhead;
}

export function effectiveInnerMtu(pathMtu: number, cfg: IpsecOverheadInput): number {
  if (pathMtu < MIN_IPV4_MTU) {
    throw new Error(`pathMtu ${pathMtu} below IPv4 minimum MTU (${MIN_IPV4_MTU})`);
  }
  return pathMtu - computeIpsecOverheadBytes(cfg);
}

export type TcpMssClampReason =
  | 'not-syn'
  | 'clamped'
  | 'inserted'
  | 'already-lower'
  | 'no-config';

export interface TcpMssClampResult {
  readonly modified: boolean;
  readonly before: number | null;
  readonly after: number | null;
  readonly reason: TcpMssClampReason;
}

export interface TcpOptionLike {
  kind: string;
  value?: number;
  [k: string]: unknown;
}

export interface TcpFlagsLike {
  syn: boolean;
  [k: string]: unknown;
}

export interface TcpMssCarrier {
  flags: TcpFlagsLike;
  options?: TcpOptionLike[];
}

export class TcpMssClamper {
  static clamp(seg: TcpMssCarrier, maxMss: number): TcpMssClampResult {
    if (!Number.isFinite(maxMss) || maxMss <= 0) {
      throw new Error(`maxMss must be a positive integer, got ${maxMss}`);
    }
    if (!seg.flags.syn) {
      return { modified: false, before: null, after: null, reason: 'not-syn' };
    }
    if (!seg.options) seg.options = [];
    const opt = seg.options.find(o => o.kind === 'mss');
    if (!opt) {
      seg.options.push({ kind: 'mss', value: maxMss });
      return { modified: true, before: null, after: maxMss, reason: 'inserted' };
    }
    const current = typeof opt.value === 'number' ? opt.value : 0;
    if (current <= maxMss) {
      return { modified: false, before: current, after: current, reason: 'already-lower' };
    }
    opt.value = maxMss;
    return { modified: true, before: current, after: maxMss, reason: 'clamped' };
  }

  static recommendedMssForTunnel(pathMtu: number, cfg: IpsecOverheadInput): number {
    return effectiveInnerMtu(pathMtu, cfg) - TCP_IP_HEADER_BYTES;
  }
}
