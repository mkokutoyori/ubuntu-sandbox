export type NatRuleType = 'static' | 'dynamic' | 'dynamic-pat' | 'no-nat' | 'nat64';

export interface SourceTranslation {
  readonly kind: 'static-ip' | 'dynamic-ip' | 'dynamic-ip-and-port' | 'interface-address';
  readonly pool?: string;
  readonly translatedAddress?: readonly string[];
  readonly fallbackToInterface?: boolean;
  readonly translatedPortFrom?: number;
  readonly translatedPortTo?: number;
}

export interface DestinationTranslation {
  readonly kind: 'static-ip' | 'dynamic-ip' | 'load-balance';
  readonly translatedAddress: string;
  readonly translatedEndAddress?: string;
  readonly translatedPort?: number;
  readonly pool?: string;
}

export interface PortCriterion {
  readonly protocol: number;
  readonly from: number;
  readonly to: number;
}

export const DEFAULT_NAT_SECTION = 0;

export interface NatRule {
  readonly id: string;
  seq: number;
  readonly section: number;
  name?: string;
  enabled: boolean;
  type: NatRuleType;

  fromZone: string[];
  toZone: string[];
  originalSource: string[];
  originalDestination: string[];
  originalService: string[];
  originalPort?: PortCriterion;
  sourcePort?: PortCriterion;

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
  section?: number;
  name?: string;
  enabled?: boolean;
  type: NatRuleType;
  fromZone?: string[];
  toZone?: string[];
  originalSource?: string[];
  originalDestination?: string[];
  originalService?: string[];
  originalPort?: PortCriterion;
  sourcePort?: PortCriterion;
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
      section: draft.section ?? DEFAULT_NAT_SECTION,
      name: draft.name,
      enabled: draft.enabled ?? true,
      type: draft.type,
      fromZone: [...(draft.fromZone ?? ['any'])],
      toZone: [...(draft.toZone ?? ['any'])],
      originalSource: [...(draft.originalSource ?? ['any'])],
      originalDestination: [...(draft.originalDestination ?? ['any'])],
      originalService: [...(draft.originalService ?? ['any'])],
      originalPort: draft.originalPort,
      sourcePort: draft.sourcePort,
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

  upsert(draft: NatRuleDraft, position = -1): void {
    this.remove(draft.id);
    this.append(draft);

    if (position < 0 || position >= this.rules.length) return;
    const added = this.rules.pop()!;
    this.rules.splice(position, 0, added);
    this.renumber();
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

  sectionOf(id: string): number | undefined {
    return this.byId(id)?.section;
  }

  size(): number {
    return this.rules.length;
  }

  resetCounters(): void {
    for (const rule of this.rules) { rule.hitCount = 0; rule.byteCount = 0; }
  }

  private renumber(): void {
    this.rules.sort((left, right) => left.section - right.section);
    this.rules.forEach((rule, index) => { rule.seq = (index + 1) * SEQ_STEP; });
  }
}
