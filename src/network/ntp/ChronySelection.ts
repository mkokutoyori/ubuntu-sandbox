import type { SourceStatistics, TrackingData } from './SourceStatistics';

export type ChronyStatus =
  | 'UNSELECTABLE' | 'UNSYNCHRONISED' | 'BAD_STATS' | 'BAD_DISTANCE' | 'JITTERY' | 'WAITS_STATS'
  | 'STALE' | 'ORPHAN' | 'UNTRUSTED' | 'FALSETICKER' | 'WAITS_SOURCES' | 'NONPREFERRED'
  | 'WAITS_UPDATE' | 'DISTANT' | 'UNSELECTED' | 'SELECTED' | 'OK';

export const STATUS_CHARACTER: Record<Exclude<ChronyStatus, 'OK'>, string> = {
  UNSELECTABLE: 'N', UNSYNCHRONISED: 's', BAD_STATS: 'M', BAD_DISTANCE: 'd', JITTERY: '~',
  WAITS_STATS: 'w', STALE: 'S', ORPHAN: 'O', UNTRUSTED: 'T', FALSETICKER: 'x', WAITS_SOURCES: 'W',
  NONPREFERRED: 'P', WAITS_UPDATE: 'U', DISTANT: 'D', UNSELECTED: '+', SELECTED: '*',
};

export interface SelectionParameters {
  maxDistance: number;
  maxJitter: number;
  reselectDistance: number;
  stratumWeight: number;
  combineLimit: number;
  minSources: number;
  orphanStratum: number;
  maxClockError: number;
}

export const DEFAULT_SELECTION_PARAMETERS: SelectionParameters = {
  maxDistance: 3.0,
  maxJitter: 1.0,
  reselectDistance: 1e-4,
  stratumWeight: 1e-3,
  combineLimit: 3.0,
  minSources: 1,
  orphanStratum: 16,
  maxClockError: 1e-6,
};

export const SCORE_LIMIT = 10.0;
export const DISTANT_PENALTY = 32;
export const SOURCE_REACH_BITS = 8;
export const BAD_HANDLE_THRESHOLD = 3;

export interface SelectionInput {
  readonly key: string;
  readonly noselect: boolean;
  readonly prefer: boolean;
  readonly trust: boolean;
  readonly require: boolean;
  readonly unsynchronised: boolean;
  readonly stratum: number;
  readonly reachability: number;
  readonly reachabilitySize: number;
  readonly refId: number;
  readonly statistics: SourceStatistics;
  readonly isNtp: boolean;
  readonly localRefId: number;
}

export interface SourceVerdict {
  status: ChronyStatus;
  score: number;
  low: number;
  high: number;
  lastSampleAgo: number;
  rootDistance: number;
}

export interface CombinedReference {
  readonly key: string;
  readonly referenceTime: number;
  readonly offset: number;
  readonly offsetDeviation: number;
  readonly frequency: number;
  readonly frequencyDeviation: number;
  readonly skew: number;
  readonly rootDelay: number;
  readonly rootDispersion: number;
  readonly combined: number;
}

export interface SelectionOutcome {
  readonly reference: CombinedReference | null;
  readonly selectedKey: string | null;
  readonly noMajority: boolean;
}

interface SourceMemory {
  status: ChronyStatus;
  score: number;
  distant: number;
  updates: number;
  bad: number;
  reportedFalseticker: boolean;
  low: number;
  high: number;
  rootDistance: number;
  stdDev: number;
  lastSampleAgo: number;
  firstSampleAgo: number;
  selectOk: boolean;
}

const square = (x: number): number => x * x;

export class ChronySelector {
  private readonly memory = new Map<string, SourceMemory>();
  private selectedKey: string | null = null;
  private lastUpdated: string | null = null;
  private onBad: ((key: string) => void) | null = null;

  setBadHandler(handler: ((key: string) => void) | null): void { this.onBad = handler; }

  selected(): string | null { return this.selectedKey; }

  verdict(key: string): SourceVerdict | null {
    const m = this.memory.get(key);
    if (m === undefined) return null;
    return {
      status: m.status, score: m.score, low: m.low, high: m.high,
      lastSampleAgo: m.lastSampleAgo, rootDistance: m.rootDistance,
    };
  }

  forget(key: string): void {
    this.memory.delete(key);
    if (this.selectedKey === key) this.selectedKey = null;
  }

  clear(): void {
    this.memory.clear();
    this.selectedKey = null;
    this.lastUpdated = null;
  }

  unselect(): void { this.selectedKey = null; }

  private slot(key: string): SourceMemory {
    let m = this.memory.get(key);
    if (m === undefined) {
      m = {
        status: 'BAD_STATS', score: 1, distant: 0, updates: 0, bad: 0, reportedFalseticker: false,
        low: 0, high: 0, rootDistance: 0, stdDev: 0, lastSampleAgo: 0, firstSampleAgo: 0, selectOk: false,
      };
      this.memory.set(key, m);
    }
    return m;
  }

  private mark(key: string, status: ChronyStatus): void {
    const m = this.slot(key);
    m.status = status;
    if (key === this.lastUpdated) {
      if (status === 'FALSETICKER' || status === 'BAD_DISTANCE' || status === 'JITTERY') m.bad++;
      else m.bad = 0;
      if (m.bad >= BAD_HANDLE_THRESHOLD) {
        m.bad = 0;
        this.onBad?.(key);
      }
    }
  }

  private markOk(inputs: readonly SelectionInput[], status: ChronyStatus): void {
    for (const input of inputs) if (this.slot(input.key).status === 'OK') this.mark(input.key, status);
  }

  select(
    inputs: readonly SelectionInput[],
    nowSeconds: number,
    parameters: SelectionParameters,
    updatedKey: string | null,
  ): SelectionOutcome {
    const none = (noMajority = false): SelectionOutcome => ({ reference: null, selectedKey: this.selectedKey, noMajority });
    for (const input of inputs) this.slot(input.key);
    for (const key of [...this.memory.keys()]) if (!inputs.some((i) => i.key === key)) this.forget(key);
    if (updatedKey !== null) {
      this.slot(updatedKey).updates++;
      this.lastUpdated = updatedKey;
    }
    if (inputs.length === 0) { this.selectedKey = null; return none(); }

    let requireSource = false;
    let badStats = 0;
    let maxSelReach = 0;
    let maxBadReach = 0;
    let maxSelReachSize = 0;
    let maxReachSampleAgo = 0;

    for (const input of inputs) {
      const m = this.slot(input.key);
      if (input.require) requireSource = true;
      if (input.noselect) { this.mark(input.key, 'UNSELECTABLE'); continue; }
      if (input.unsynchronised) { this.mark(input.key, 'UNSYNCHRONISED'); continue; }
      const data = input.statistics.selection(nowSeconds);
      if (data === null || !data.selectable) {
        badStats++;
        m.low = 0; m.high = 0; m.rootDistance = 0; m.lastSampleAgo = data?.lastSampleAgo ?? 0;
        this.mark(input.key, 'BAD_STATS');
        if (maxBadReach < input.reachability) maxBadReach = input.reachability;
        continue;
      }
      m.low = data.offsetLow; m.high = data.offsetHigh; m.rootDistance = data.rootDistance;
      m.stdDev = data.standardDeviation; m.firstSampleAgo = data.firstSampleAgo; m.lastSampleAgo = data.lastSampleAgo;
      if (data.firstSampleAgo < 2.0 * data.lastSampleAgo) {
        const extra = parameters.maxClockError * (2.0 * data.lastSampleAgo - data.firstSampleAgo);
        m.rootDistance += extra; m.low -= extra; m.high += extra;
      }
      if (!(m.rootDistance <= parameters.maxDistance && m.low <= m.high)) { this.mark(input.key, 'BAD_DISTANCE'); continue; }
      if (m.stdDev > parameters.maxJitter) { this.mark(input.key, 'JITTERY'); continue; }
      m.status = 'OK';
      if (input.reachability !== 0 && maxReachSampleAgo < m.firstSampleAgo) maxReachSampleAgo = m.firstSampleAgo;
      if (maxSelReach < input.reachability) maxSelReach = input.reachability;
      if (maxSelReachSize < input.reachabilitySize) maxSelReachSize = input.reachabilitySize;
    }

    let orphanInput: SelectionInput | null = null;
    let selectable = 0;
    for (const input of inputs) {
      const m = this.slot(input.key);
      if (m.status !== 'OK') continue;
      if (input.reachability === 0 && maxReachSampleAgo < m.lastSampleAgo) { this.mark(input.key, 'STALE'); continue; }
      if (input.stratum >= parameters.orphanStratum && input.isNtp) {
        this.mark(input.key, 'ORPHAN');
        if (input.stratum === parameters.orphanStratum && input.reachability !== 0
          && (orphanInput === null || input.refId < orphanInput.refId)) orphanInput = input;
        continue;
      }
      selectable++;
    }
    if (selectable === 0 && orphanInput !== null && orphanInput.localRefId !== 0 && orphanInput.refId < orphanInput.localRefId) {
      this.slot(orphanInput.key).status = 'OK';
      selectable = 1;
    }

    const live = inputs.filter((i) => this.slot(i.key).status === 'OK');
    const trustCount = live.filter((i) => i.trust).length;

    if (badStats > 0 && selectable > 0 && this.selectedKey === null
      && maxSelReachSize < SOURCE_REACH_BITS && (maxSelReach >> 1) === maxBadReach) {
      this.markOk(inputs, 'WAITS_STATS');
      this.selectedKey = null;
      return none();
    }
    if (live.length === 0) { this.selectedKey = null; return none(); }

    interface Edge { input: SelectionInput; offset: number; tag: 0 | 1 }
    const edges: Edge[] = [];
    for (const input of live) {
      const m = this.slot(input.key);
      edges.push({ input, offset: m.low, tag: 0 }, { input, offset: m.high, tag: 1 });
    }
    edges.sort((a, b) => a.offset - b.offset || a.tag - b.tag);

    let depth = 0; let bestDepth = 0; let trustDepth = 0; let bestTrustDepth = 0;
    let bestLow = 0; let bestHigh = 0; let bestTrustLow = 0; let bestTrustHigh = 0;
    for (const edge of edges) {
      if (edge.tag === 0) {
        depth++;
        if (edge.input.trust) trustDepth++;
        if (trustDepth > bestTrustDepth || (trustDepth === bestTrustDepth && depth > bestDepth)) {
          if (trustDepth > bestTrustDepth) { bestTrustDepth = trustDepth; bestTrustLow = edge.offset; }
          bestDepth = depth;
          bestLow = edge.offset;
        }
      } else {
        if (trustDepth === bestTrustDepth) {
          if (depth === bestDepth) bestHigh = edge.offset;
          bestTrustHigh = edge.offset;
        }
        if (edge.input.trust) trustDepth--;
        depth--;
      }
    }

    if ((bestTrustDepth === 0 && bestDepth <= Math.trunc(selectable / 2))
      || (bestTrustDepth > 0 && bestTrustDepth <= Math.trunc(trustCount / 2))) {
      this.selectedKey = null;
      this.markOk(inputs, 'FALSETICKER');
      return none(true);
    }

    let admissible: SelectionInput[] = [];
    for (const input of live) {
      const m = this.slot(input.key);
      const covers = (m.low <= bestLow && m.high >= bestHigh) || (m.low >= bestLow && m.high <= bestHigh);
      if (covers) {
        if (!(bestTrustDepth === 0 || input.trust || (m.low >= bestTrustLow && m.high <= bestTrustHigh))) {
          this.mark(input.key, 'UNTRUSTED');
          continue;
        }
        admissible.push(input);
        if (input.require) requireSource = false;
      } else {
        this.mark(input.key, 'FALSETICKER');
        m.reportedFalseticker = true;
      }
    }

    if (admissible.length === 0 || requireSource || admissible.length < parameters.minSources) {
      this.selectedKey = null;
      this.markOk(inputs, 'WAITS_SOURCES');
      return none();
    }

    const preferred = admissible.some((i) => i.prefer);
    if (preferred) {
      const kept: SelectionInput[] = [];
      for (const input of admissible) {
        if (input.prefer) kept.push(input);
        else this.mark(input.key, 'NONPREFERRED');
      }
      admissible = kept;
    }

    const minStratum = Math.min(...admissible.map((i) => i.stratum));
    const selectedMemory = this.selectedKey !== null ? this.memory.get(this.selectedKey) : undefined;
    const selectedInput = this.selectedKey !== null ? inputs.find((i) => i.key === this.selectedKey) : undefined;
    const selectedDistance = selectedMemory && selectedInput
      ? selectedMemory.rootDistance + (selectedInput.stratum - minStratum) * parameters.stratumWeight : 0;

    let maxScore = 0;
    let maxScoreKey: string | null = null;
    for (const input of inputs) {
      const m = this.slot(input.key);
      if (m.status !== 'OK' || (preferred && !input.prefer)) {
        m.score = 1.0;
        m.distant = DISTANT_PENALTY;
        continue;
      }
      let distance = m.rootDistance + (input.stratum - minStratum) * parameters.stratumWeight;
      if (input.isNtp) distance += parameters.reselectDistance;
      if (this.selectedKey !== null) {
        if (input.key === updatedKey || this.selectedKey === updatedKey) {
          m.score *= selectedDistance / distance;
          if (m.score < 1.0) m.score = 1.0;
        }
      } else {
        m.score = 1.0 / distance;
      }
      if (maxScore < m.score) { maxScore = m.score; maxScoreKey = input.key; }
    }
    if (maxScoreKey === null) { this.selectedKey = null; return none(); }

    if (this.selectedKey === null || this.slot(this.selectedKey).status !== 'OK'
      || (maxScoreKey !== this.selectedKey && maxScore > SCORE_LIMIT)) {
      if (this.slot(maxScoreKey).updates === 0) {
        this.selectedKey = null;
        this.markOk(inputs, 'WAITS_UPDATE');
        return none();
      }
      this.selectedKey = maxScoreKey;
      for (const input of inputs) {
        const m = this.slot(input.key);
        m.score = 1.0; m.distant = 0; m.reportedFalseticker = false;
      }
    }

    const selectedKey = this.selectedKey!;
    this.mark(selectedKey, 'SELECTED');

    if (this.slot(selectedKey).updates === 0) {
      for (const input of admissible) {
        const m = this.slot(input.key);
        if (m.status === 'OK') this.mark(input.key, m.distant !== 0 ? 'DISTANT' : 'UNSELECTED');
      }
      return { reference: null, selectedKey, noMajority: false };
    }

    for (const m of this.memory.values()) m.updates = 0;
    return { reference: this.combine(inputs, admissible, selectedKey, parameters), selectedKey, noMajority: false };
  }

  private combine(
    inputs: readonly SelectionInput[],
    admissible: readonly SelectionInput[],
    selectedKey: string,
    parameters: SelectionParameters,
  ): CombinedReference | null {
    const selectedInput = inputs.find((i) => i.key === selectedKey)!;
    const base = selectedInput.statistics.tracking();
    if (base === null) return null;
    let offset = base.averageOffset;
    let offsetDeviation = base.offsetStandardDeviation;
    let frequency = base.frequency;
    let frequencyDeviation = base.frequencyStandardDeviation;
    let skew = base.skew;
    const referenceTime = base.referenceTime;
    let combined = 1;

    if (admissible.length > 1) {
      let sumOffsetWeight = 0; let sumOffset = 0; let sumOffsetSd2 = 0;
      let sumFrequencyWeight = 0; let sumFrequency = 0; let invFrequencySd2 = 0; let invSkew2 = 0;
      let selectedDistance = this.slot(selectedKey).rootDistance;
      if (selectedInput.isNtp) selectedDistance += parameters.reselectDistance;
      combined = 0;
      for (const input of admissible) {
        const data: TrackingData | null = input.statistics.tracking();
        if (data === null) continue;
        const m = this.slot(input.key);
        if (input.key !== selectedKey
          && (m.rootDistance > parameters.combineLimit * selectedDistance
            || Math.abs(frequency - data.frequency) > parameters.combineLimit * (skew + data.skew + parameters.maxClockError))) {
          m.distant = input.reachabilitySize >= SOURCE_REACH_BITS ? DISTANT_PENALTY : 1;
        } else if (m.distant > 0) {
          m.distant--;
        }
        if (m.distant > 0) { this.mark(input.key, 'DISTANT'); continue; }
        if (m.status === 'OK') this.mark(input.key, 'UNSELECTED');
        const elapsed = referenceTime - data.referenceTime;
        const sourceOffset = data.averageOffset + elapsed * data.frequency;
        const sourceOffsetSd = data.offsetStandardDeviation + elapsed * data.frequencyStandardDeviation;
        const offsetWeight = 1.0 / m.rootDistance;
        const frequencyWeight = 1.0 / square(data.frequencyStandardDeviation);
        sumOffsetWeight += offsetWeight;
        sumOffset += offsetWeight * sourceOffset;
        sumOffsetSd2 += offsetWeight * (square(sourceOffsetSd) + square(sourceOffset - offset));
        sumFrequencyWeight += frequencyWeight;
        sumFrequency += frequencyWeight * data.frequency;
        invFrequencySd2 += 1.0 / square(data.frequencyStandardDeviation);
        invSkew2 += 1.0 / square(data.skew);
        combined++;
      }
      if (combined > 0) {
        offset = sumOffset / sumOffsetWeight;
        offsetDeviation = Math.sqrt(sumOffsetSd2 / sumOffsetWeight);
        frequency = sumFrequency / sumFrequencyWeight;
        frequencyDeviation = 1.0 / Math.sqrt(invFrequencySd2);
        skew = 1.0 / Math.sqrt(invSkew2);
      } else {
        combined = 1;
      }
    }
    return {
      key: selectedKey, referenceTime, offset, offsetDeviation, frequency, frequencyDeviation, skew,
      rootDelay: base.rootDelay, rootDispersion: base.rootDispersion, combined,
    };
  }
}
