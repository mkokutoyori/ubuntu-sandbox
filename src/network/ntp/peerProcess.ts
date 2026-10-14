import {
  type NtpAssociation, type NtpFilterStage, type NtpSystemState,
  NTP_STAGES, NTP_MAX_DISPERSION_MS, NTP_MIN_DISPERSION_MS, NTP_MAX_DISTANCE_MS, NTP_PHI,
  NTP_MIN_POLL, NTP_MAX_POLL, NTP_MAX_STRATUM, NTP_BURST_COUNT, NTP_BURST_INTERVAL_MS,
  NTP_UNREACH_LIMIT, NTP_SPIKE_GATE, emptyFilter,
} from './types';
import { NTP_TIMESTAMP_ZERO } from './timestamp';

export const PRECISION_FLOOR_MS = (precision: number): number => 1000 * 2 ** precision;

export function pollSeconds(exponent: number): number {
  return 2 ** exponent;
}

export function rootDistanceMs(peer: NtpAssociation, nowMs: number): number {
  return Math.max(NTP_MIN_DISPERSION_MS, peer.rootDelayMs + peer.delayMs) / 2
    + peer.rootDispersionMs + peer.dispersionMs + NTP_PHI * (nowMs - peer.updateMs) + peer.jitterMs;
}

export function isFit(peer: NtpAssociation, nowMs: number, system: NtpSystemState, localAddress: string | null, systemRefId: string, enforceDistance = true): boolean {
  if (peer.leap === 3 || peer.stratum >= NTP_MAX_STRATUM) return false;
  if (enforceDistance && rootDistanceMs(peer, nowMs) > NTP_MAX_DISTANCE_MS + NTP_PHI * pollSeconds(system.poll) * 1000) return false;
  if (peer.refId !== '' && (peer.refId === localAddress || peer.refId === systemRefId)) return false;
  return peer.reach !== 0;
}

export function resetPeer(peer: NtpAssociation, system: NtpSystemState, nowMs: number, kiss = ''): void {
  peer.leap = 3;
  peer.stratum = NTP_MAX_STRATUM;
  peer.ppoll = NTP_MAX_POLL;
  peer.hpoll = peer.minpoll;
  peer.dispersionMs = NTP_MAX_DISPERSION_MS;
  peer.jitterMs = PRECISION_FLOOR_MS(system.precision);
  peer.refId = kiss;
  peer.org = NTP_TIMESTAMP_ZERO;
  peer.rec = NTP_TIMESTAMP_ZERO;
  peer.xmt = NTP_TIMESTAMP_ZERO;
  peer.offsetMs = 0;
  peer.delayMs = 0;
  peer.rootDelayMs = 0;
  peer.rootDispersionMs = 0;
  peer.reach = 0;
  peer.burst = 0;
  peer.unreach = 0;
  peer.synced = false;
  peer.statistics.reset();
  peer.filter = emptyFilter();
  peer.updateMs = nowMs;
  peer.outdateMs = nowMs;
  peer.nextdateMs = nowMs;
}

export interface FilterOutcome {
  readonly accepted: boolean;
}

export function clockFilter(
  peer: NtpAssociation, offsetMs: number, delayMs: number, dispersionMs: number,
  nowMs: number, system: NtpSystemState,
): FilterOutcome {
  const aged: NtpFilterStage[] = [];
  for (let i = 0; i < NTP_STAGES - 1; i++) {
    const stage = peer.filter[i];
    aged.push({ ...stage, dispersionMs: stage.dispersionMs + NTP_PHI * (nowMs - peer.updateMs) });
  }
  peer.filter = [{ t: nowMs, offsetMs, delayMs, dispersionMs }, ...aged];
  const sorted = [...peer.filter].sort((a, b) => {
    const aInvalid = a.dispersionMs >= NTP_MAX_DISPERSION_MS;
    const bInvalid = b.dispersionMs >= NTP_MAX_DISPERSION_MS;
    if (aInvalid !== bInvalid) return aInvalid ? 1 : -1;
    return a.delayMs - b.delayMs;
  });
  const previousOffset = peer.offsetMs;
  const hadSamples = aged.some((stage) => stage.dispersionMs < NTP_MAX_DISPERSION_MS);
  const best = sorted[0];
  peer.offsetMs = best.offsetMs;
  peer.delayMs = best.delayMs;
  let dispersion = 0;
  let squares = 0;
  let valid = 0;
  for (let i = 0; i < NTP_STAGES; i++) {
    dispersion += sorted[i].dispersionMs / 2 ** (i + 1);
    if (sorted[i].dispersionMs < NTP_MAX_DISPERSION_MS) {
      valid++;
      squares += (sorted[i].offsetMs - best.offsetMs) ** 2;
    }
  }
  peer.dispersionMs = dispersion;
  const floor = PRECISION_FLOOR_MS(system.precision);
  peer.jitterMs = Math.max(valid > 1 ? Math.sqrt(squares / (valid - 1)) : 0, floor);
  if (best.t - peer.updateMs <= 0 && system.leap !== 3) return { accepted: false };
  if (Math.abs(peer.offsetMs - previousOffset) > NTP_SPIKE_GATE * peer.jitterMs
    && best.t - peer.updateMs < 2 * pollSeconds(system.poll) * 1000
    && hadSamples) return { accepted: false };
  peer.updateMs = best.t;
  return { accepted: true };
}

export function pollUpdate(peer: NtpAssociation, requested: number, nowMs: number, fromPoll = false): void {
  peer.hpoll = Math.max(Math.min(peer.maxpoll, requested), peer.minpoll);
  if (peer.burst > 0) {
    if (!fromPoll && peer.nextdateMs !== nowMs) return;
    peer.nextdateMs = nowMs + NTP_BURST_INTERVAL_MS;
  } else {
    const exponent = Math.max(Math.min(peer.ppoll, peer.hpoll), peer.minpoll);
    peer.nextdateMs = peer.outdateMs + pollSeconds(exponent) * 1000;
  }
  if (peer.nextdateMs <= nowMs) peer.nextdateMs = nowMs + 1000;
  peer.pollSec = pollSeconds(Math.max(Math.min(peer.ppoll, peer.hpoll), peer.minpoll));
}

export interface PollDecision {
  readonly transmit: boolean;
  readonly agedSample: boolean;
}

export function pollTick(
  peer: NtpAssociation, nowMs: number, system: NtpSystemState, fit: (peer: NtpAssociation) => boolean,
): PollDecision {
  let hpoll = peer.hpoll;
  let agedSample = false;
  if (peer.burst === 0) {
    peer.outdateMs = nowMs;
    peer.reach = (peer.reach << 1) & 0xff;
    if ((peer.reach & 0x7) === 0) agedSample = true;
    if (peer.reach === 0) {
      if (peer.iburst && peer.unreach === 0) {
        peer.burst = NTP_BURST_COUNT - 1;
        peer.unreach++;
      } else if (peer.unreach < NTP_UNREACH_LIMIT) {
        peer.unreach++;
      } else {
        hpoll++;
      }
    } else {
      peer.unreach = 0;
      hpoll = system.poll;
      if (peer.burstMode && fit(peer)) peer.burst = NTP_BURST_COUNT - 1;
    }
  } else {
    peer.burst--;
  }
  pollUpdate(peer, hpoll, nowMs, true);
  return { transmit: true, agedSample };
}

export function minPollOf(peer: NtpAssociation): number {
  return Math.max(NTP_MIN_POLL, peer.minpoll);
}
