export type DuplicationMode = 'disable' | 'force';

export interface DuplicationRule {
  readonly id: string;
  readonly srcIntf: readonly string[];
  readonly dstIntf: readonly string[];
  readonly srcAddr: readonly string[];
  readonly dstAddr: readonly string[];
  readonly services: readonly string[];
  readonly mode: DuplicationMode;
  readonly deDuplicate: boolean;
  readonly maxCopies: number;
}

const SEEN_LIMIT = 4096;

export class SdwanDuplication {
  private rules: readonly DuplicationRule[] = [];
  private readonly seen = new Set<string>();

  replace(rules: readonly DuplicationRule[]): void { this.rules = Object.freeze([...rules]); }

  list(): readonly DuplicationRule[] { return this.rules; }

  seenBefore(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }
}
