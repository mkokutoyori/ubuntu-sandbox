import { type NtpAssociation, NTP_MAX_DISTANCE_MS } from './types';
import { rootDistanceMs } from './peerProcess';

const MIN_CLUSTER_SURVIVORS = 3;
const MIN_INTERSECTION_SURVIVORS = 1;

interface ChimeEdge {
  readonly peer: NtpAssociation;
  readonly type: -1 | 0 | 1;
  readonly edge: number;
}

export interface SelectionResult {
  readonly candidates: NtpAssociation[];
  readonly truechimers: NtpAssociation[];
  readonly survivors: NtpAssociation[];
  readonly falsetickers: NtpAssociation[];
}

export function intersect(candidates: NtpAssociation[], nowMs: number): { low: number; high: number } | null {
  const m = candidates.length;
  const chime: ChimeEdge[] = [];
  for (const peer of candidates) {
    const distance = rootDistanceMs(peer, nowMs);
    chime.push({ peer, type: 1, edge: peer.offsetMs + distance });
    chime.push({ peer, type: 0, edge: peer.offsetMs });
    chime.push({ peer, type: -1, edge: peer.offsetMs - distance });
  }
  chime.sort((a, b) => a.edge - b.edge || a.type - b.type);
  for (let allow = 0; 2 * allow < m; allow++) {
    let found = 0;
    let count = 0;
    let low = 2e9;
    let high = -2e9;
    for (let i = 0; i < chime.length; i++) {
      count -= chime[i].type;
      if (count >= m - allow) { low = chime[i].edge; break; }
      if (chime[i].type === 0) found++;
    }
    count = 0;
    for (let i = chime.length - 1; i >= 0; i--) {
      count += chime[i].type;
      if (count >= m - allow) { high = chime[i].edge; break; }
      if (chime[i].type === 0) found++;
    }
    if (found > allow) continue;
    if (high > low) return { low, high };
  }
  return null;
}

export function selectSources(fitPeers: NtpAssociation[], nowMs: number): SelectionResult {
  const none: SelectionResult = { candidates: fitPeers, truechimers: [], survivors: [], falsetickers: [] };
  if (fitPeers.length === 0) return none;
  const interval = intersect(fitPeers, nowMs);
  if (interval === null) return { ...none, falsetickers: fitPeers };
  const truechimers = fitPeers.filter((peer) => peer.offsetMs >= interval.low && peer.offsetMs <= interval.high);
  const falsetickers = fitPeers.filter((peer) => !truechimers.includes(peer));
  if (truechimers.length < MIN_INTERSECTION_SURVIVORS) return { ...none, falsetickers };
  const metric = (peer: NtpAssociation): number => NTP_MAX_DISTANCE_MS * peer.stratum + rootDistanceMs(peer, nowMs);
  const survivors = [...truechimers].sort((a, b) => metric(a) - metric(b));
  while (survivors.length > MIN_CLUSTER_SURVIVORS) {
    let worst: NtpAssociation | null = null;
    let worstJitter = -Infinity;
    let minimumPeerJitter = Infinity;
    for (const peer of survivors) {
      minimumPeerJitter = Math.min(minimumPeerJitter, peer.jitterMs);
      let sum = 0;
      for (const other of survivors) sum += (peer.offsetMs - other.offsetMs) ** 2;
      const selectionJitter = Math.sqrt(sum / survivors.length);
      if (selectionJitter > worstJitter && !peer.prefer) { worstJitter = selectionJitter; worst = peer; }
    }
    if (worst === null || worstJitter < minimumPeerJitter) break;
    survivors.splice(survivors.indexOf(worst), 1);
  }
  return { candidates: fitPeers, truechimers, survivors, falsetickers };
}

export interface CombineResult {
  readonly offsetMs: number;
  readonly jitterMs: number;
}

export function combineOffsets(survivors: NtpAssociation[], nowMs: number): CombineResult {
  let weightSum = 0;
  let weighted = 0;
  let squares = 0;
  for (const peer of survivors) {
    const weight = 1 / rootDistanceMs(peer, nowMs);
    weightSum += weight;
    weighted += peer.offsetMs * weight;
    squares += ((peer.offsetMs - survivors[0].offsetMs) ** 2) * weight;
  }
  return { offsetMs: weighted / weightSum, jitterMs: Math.sqrt(squares / weightSum) };
}

export function chooseSystemPeer(survivors: NtpAssociation[], previous: NtpAssociation | undefined): NtpAssociation {
  const preferred = survivors.find((peer) => peer.prefer);
  if (preferred) return preferred;
  if (previous && survivors.includes(previous) && previous.stratum === survivors[0].stratum) return previous;
  return survivors[0];
}
