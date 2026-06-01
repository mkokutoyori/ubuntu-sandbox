export const UDP_PORT_BFD_CONTROL = 3784;
export const UDP_PORT_BFD_ECHO = 3785;

export type BfdState = 'admin-down' | 'down' | 'init' | 'up';

export type BfdDiagnostic =
  | 'none'
  | 'control-detection-time-expired'
  | 'echo-function-failed'
  | 'neighbor-signaled-session-down'
  | 'forwarding-plane-reset'
  | 'path-down'
  | 'concatenated-path-down'
  | 'admin-down'
  | 'reverse-concatenated-path-down';

export interface BfdPacket {
  type: 'bfd';
  version: 1;
  diagnostic: BfdDiagnostic;
  state: BfdState;
  poll: boolean;
  final: boolean;
  controlPlaneIndependent: boolean;
  authPresent: boolean;
  demand: boolean;
  multipoint: boolean;
  detectMultiplier: number;
  myDiscriminator: number;
  yourDiscriminator: number;
  desiredMinTxIntervalUs: number;
  requiredMinRxIntervalUs: number;
  requiredMinEchoRxIntervalUs: number;
}

export interface BfdSessionRuntime {
  iface: string;
  neighborIp: string;
  localDiscriminator: number;
  remoteDiscriminator: number;
  state: BfdState;
  remoteState: BfdState;
  localDiag: BfdDiagnostic;
  remoteDiag: BfdDiagnostic;
  desiredMinTxUs: number;
  requiredMinRxUs: number;
  detectMultiplier: number;
  remoteMinTxUs: number;
  remoteMinRxUs: number;
  lastHeardMs: number;
  lastTxMs: number;
  lastTransitionMs: number;
  adminUp: boolean;
}

export interface BfdConfig {
  enabled: boolean;
  sessions: Map<string, BfdSessionRuntime>;
}

export function makeKey(iface: string, neighborIp: string): string {
  return `${iface}|${neighborIp}`;
}

export function createDefaultBfdConfig(): BfdConfig {
  return { enabled: true, sessions: new Map() };
}

let discCounter = 1;
export function nextDiscriminator(): number {
  return ++discCounter;
}

export function defaultSession(iface: string, neighborIp: string): BfdSessionRuntime {
  return {
    iface, neighborIp,
    localDiscriminator: nextDiscriminator(),
    remoteDiscriminator: 0,
    state: 'down', remoteState: 'down',
    localDiag: 'none', remoteDiag: 'none',
    desiredMinTxUs: 1_000_000,
    requiredMinRxUs: 1_000_000,
    detectMultiplier: 3,
    remoteMinTxUs: 0, remoteMinRxUs: 0,
    lastHeardMs: 0, lastTxMs: 0,
    lastTransitionMs: Date.now(),
    adminUp: true,
  };
}

export function detectionTimeMs(s: BfdSessionRuntime): number {
  const txUs = Math.max(s.desiredMinTxUs, s.remoteMinRxUs);
  const mult = s.detectMultiplier;
  return Math.max(50, (txUs * mult) / 1000);
}

export function negotiatedTxIntervalMs(s: BfdSessionRuntime): number {
  const txUs = Math.max(s.desiredMinTxUs, s.remoteMinRxUs || s.desiredMinTxUs);
  return Math.max(50, txUs / 1000);
}
