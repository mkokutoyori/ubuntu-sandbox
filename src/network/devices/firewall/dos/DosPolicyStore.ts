import { PolicyStore, type RuleDraft } from '../model/PolicyStore';
import type { SecurityRule } from '../model/SecurityRule';
import type { AnomalySetting } from './DosSensor';

export class DosPolicyStore {
  private readonly rules = new PolicyStore();
  private readonly anomalies = new Map<string, readonly AnomalySetting[]>();

  upsert(draft: RuleDraft, anomalies: readonly AnomalySetting[]): void {
    this.rules.remove(draft.id);
    this.rules.append(draft);
    this.anomalies.set(draft.id, Object.freeze([...anomalies]));
  }

  remove(id: string): void {
    this.rules.remove(id);
    this.anomalies.delete(id);
  }

  ordered(): readonly SecurityRule[] { return this.rules.ordered(); }

  anomaliesOf(id: string): readonly AnomalySetting[] {
    return this.anomalies.get(id) ?? [];
  }

  size(): number { return this.rules.size(); }
}
