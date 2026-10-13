import type { NtpAssociation } from './types';

const BURST_INTERVAL_SECONDS = 2;
const BURST_POLL_RATIO = 0.25;
const IBURST_GOOD_SAMPLES = 4;
const IBURST_TOTAL_SAMPLES = 8;
const DEFAULT_POLL_TARGET = 8;
const MIN_NONLAN_POLL = 0;
const MAX_LAN_PEER_DELAY_SECONDS = 0.01;
const REACH_BITS = 8;

export function adjustPoll(peer: NtpAssociation, adjustment: number, reachable: boolean, minDelaySeconds: number): void {
  peer.pollScore += adjustment;
  if (peer.pollScore >= 1) {
    const whole = Math.trunc(peer.pollScore);
    peer.hpoll += whole;
    peer.pollScore -= whole;
  }
  if (peer.pollScore < 0) {
    const whole = Math.trunc(peer.pollScore - 1);
    peer.hpoll += whole;
    peer.pollScore -= whole;
  }
  if (peer.hpoll < peer.minpoll) {
    peer.hpoll = peer.minpoll;
    peer.pollScore = 0;
  } else if (peer.hpoll > peer.maxpoll) {
    peer.hpoll = peer.maxpoll;
    peer.pollScore = 1;
  }
  if (peer.hpoll < MIN_NONLAN_POLL && (!reachable || minDelaySeconds > MAX_LAN_PEER_DELAY_SECONDS)) {
    peer.hpoll = MIN_NONLAN_POLL;
  }
}

export function pollAdjustment(peer: NtpAssociation, errorInEstimate: number, peerDistance: number): number {
  if (errorInEstimate > peerDistance) return -Math.log(errorInEstimate / peerDistance) / Math.log(2);
  const samples = peer.statistics.getSampleCount();
  const target = peer.pollTarget ?? DEFAULT_POLL_TARGET;
  let adjustment = (samples / target - 1) / target;
  if (samples < target) adjustment *= 2;
  return adjustment;
}

export function startBurst(peer: NtpAssociation, goodSamples: number, totalSamples: number): void {
  peer.burstGood = Math.max(0, goodSamples);
  peer.burst = Math.max(0, totalSamples);
}

export function startInitialBurst(peer: NtpAssociation): void {
  startBurst(peer, IBURST_GOOD_SAMPLES, IBURST_TOTAL_SAMPLES);
}

export interface ChronyTransmitDecision {
  readonly missedSample: boolean;
}

export function chronyTransmitTick(peer: NtpAssociation, nowMs: number, isSystemPeer: boolean): ChronyTransmitDecision {
  peer.txCount++;
  let missedSample = false;
  if (peer.txCount >= 2) {
    const delays = peer.statistics.peerDelays();
    const minimum = delays.length > 0 ? Math.min(...delays) : 0;
    adjustPoll(peer, isSystemPeer ? 0.1 : 0.25, peer.reach !== 0, minimum);
    peer.reach = (peer.reach << 1) & ((1 << REACH_BITS) - 1);
    missedSample = true;
  }
  const interval = 2 ** peer.hpoll;
  let delay = interval;
  if (peer.burst > 0) {
    delay = Math.min(BURST_INTERVAL_SECONDS, BURST_POLL_RATIO * interval);
    peer.burst--;
  } else if (peer.burstMode && peer.hpoll > peer.minpoll) {
    startBurst(peer, 1, Math.min(2 ** (peer.hpoll - peer.minpoll), 8));
  }
  peer.nextdateMs = nowMs + delay * 1000;
  peer.pollSec = interval;
  peer.outdateMs = nowMs;
  return { missedSample };
}

export function chronyValidResponse(peer: NtpAssociation): void {
  peer.txCount = 0;
  peer.reach = ((peer.reach << 1) | 1) & ((1 << REACH_BITS) - 1);
  if (peer.burstGood > 0) {
    peer.burstGood--;
    if (peer.burstGood <= 0) peer.burst = 0;
  }
}
