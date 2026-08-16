export type NatRuleType = 'static' | 'dynamic' | 'dynamic-pat' | 'no-nat' | 'nat64';

export interface SourceTranslation {
  readonly kind: 'static-ip' | 'dynamic-ip' | 'dynamic-ip-and-port' | 'interface-address';
  readonly pool?: string;
  readonly translatedAddress?: readonly string[];
  readonly fallbackToInterface?: boolean;
}

export interface DestinationTranslation {
  readonly kind: 'static-ip' | 'dynamic-ip';
  readonly translatedAddress: string;
  readonly translatedPort?: number;
}

export interface NatRule {
  readonly id: string;
  seq: number;
  name?: string;
  enabled: boolean;
  type: NatRuleType;

  fromZone: string[];
  toZone: string[];
  originalSource: string[];
  originalDestination: string[];
  originalService: string[];

  sourceTranslation?: SourceTranslation;
  destinationTranslation?: DestinationTranslation;

  bidirectional: boolean;
  noTranslation: boolean;

  hitCount: number;
  byteCount: number;
  comment?: string;
}

export interface NatRuleDraft {
  id: string;
  name?: string;
  enabled?: boolean;
  type: NatRuleType;
  fromZone?: string[];
  toZone?: string[];
  originalSource?: string[];
  originalDestination?: string[];
  originalService?: string[];
  sourceTranslation?: SourceTranslation;
  destinationTranslation?: DestinationTranslation;
  bidirectional?: boolean;
  noTranslation?: boolean;
  comment?: string;
}

const SEQ_STEP = 10;

export class NatPolicyStore {
  private rules: NatRule[] = [];

  append(draft: NatRuleDraft): boolean {
    if (this.byId(draft.id)) return false;

    this.rules.push({
      id: draft.id,
      seq: 0,
      name: draft.name,
      enabled: draft.enabled ?? true,
      type: draft.type,
      fromZone: [...(draft.fromZone ?? ['any'])],
      toZone: [...(draft.toZone ?? ['any'])],
      originalSource: [...(draft.originalSource ?? ['any'])],
      originalDestination: [...(draft.originalDestination ?? ['any'])],
      originalService: [...(draft.originalService ?? ['any'])],
      sourceTranslation: draft.sourceTranslation,
      destinationTranslation: draft.destinationTranslation,
      bidirectional: draft.bidirectional ?? false,
      noTranslation: draft.noTranslation ?? draft.type === 'no-nat',
      hitCount: 0,
      byteCount: 0,
      comment: draft.comment,
    });
    this.renumber();
    return true;
  }

  remove(id: string): boolean {
    const index = this.rules.findIndex(rule => rule.id === id);
    if (index < 0) return false;

    this.rules.splice(index, 1);
    this.renumber();
    return true;
  }

  byId(id: string): NatRule | undefined {
    return this.rules.find(rule => rule.id === id);
  }

  ordered(): readonly NatRule[] {
    return Object.freeze([...this.rules]);
  }

  size(): number {
    return this.rules.length;
  }

  resetCounters(): void {
    for (const rule of this.rules) { rule.hitCount = 0; rule.byteCount = 0; }
  }

  private renumber(): void {
    this.rules.forEach((rule, index) => { rule.seq = (index + 1) * SEQ_STEP; });
  }
}
