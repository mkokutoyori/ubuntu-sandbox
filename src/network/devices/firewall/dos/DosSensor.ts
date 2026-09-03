import type { SessionTableView } from '../session/SessionTable';
import {
  familyCovers, type AnomalyKind, type AnomalySpec, type IpVersion,
} from './AnomalyCatalog';

export type AnomalyAction = 'pass' | 'block';

export interface AnomalySetting {
  readonly name: string;
  readonly enabled: boolean;
  readonly log: boolean;
  readonly action: AnomalyAction;
  readonly threshold: number;
}

export interface DosSubject {
  readonly sourceIP: string;
  readonly destIP: string;
  readonly protocol: number;
  readonly version: IpVersion;
}

export interface DosFinding {
  readonly anomaly: string;
  readonly action: AnomalyAction;
  readonly log: boolean;
  readonly observed: number;
  readonly threshold: number;
}

export interface DosSensorDeps {
  readonly now: () => number;
  readonly sessions: () => SessionTableView;
}

const WINDOW_MS = 1000;

function rateKey(kind: AnomalyKind, subject: DosSubject): string {
  return kind === 'flood' ? subject.destIP : subject.sourceIP;
}

export class DosSensor {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly deps: DosSensorDeps) {}

  reset(): void { this.buckets.clear(); }

  evaluate(
    policyId: string, spec: AnomalySpec, setting: AnomalySetting, subject: DosSubject,
  ): DosFinding | null {
    if (!setting.enabled) return null;
    if (!familyCovers(spec.family, subject.protocol, subject.version)) return null;

    const observed = spec.kind === 'flood' || spec.kind === 'scan'
      ? this.countRate(`${policyId}|${spec.name}|${rateKey(spec.kind, subject)}`)
      : this.countConcurrentSessions(spec, subject);

    if (observed <= setting.threshold) return null;
    return Object.freeze({
      anomaly: spec.name, action: setting.action, log: setting.log,
      observed, threshold: setting.threshold,
    });
  }

  private countRate(key: string): number {
    const at = this.deps.now();
    const bucket = this.buckets.get(key);
    if (!bucket || at - bucket.startedAt >= WINDOW_MS) {
      this.buckets.set(key, { startedAt: at, count: 1 });
      return 1;
    }
    bucket.count += 1;
    return bucket.count;
  }

  private countConcurrentSessions(spec: AnomalySpec, subject: DosSubject): number {
    const bySource = spec.kind === 'src-session';
    const peer = bySource ? subject.sourceIP : subject.destIP;
    const already = this.deps.sessions().find(session => {
      if (!familyCovers(spec.family, session.c2s.protocol, subject.version)) return false;
      return bySource ? session.c2s.sourceIP === peer : session.c2s.destIP === peer;
    }).length;
    return already + 1;
  }
}
