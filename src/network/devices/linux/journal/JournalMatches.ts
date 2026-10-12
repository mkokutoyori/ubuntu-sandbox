import { equalBytes, utf8 } from './JournalText';
import { type JournalRecord } from './JournalRecord';

export type MatchError = 'EINVAL';

interface Level2 {
  groups: Array<{ field: string; values: Uint8Array[] }>;
}

interface Level1 {
  terms: Level2[];
}

function groupMatches(record: JournalRecord, group: { field: string; values: Uint8Array[] }): boolean {
  for (const [name, value] of record.fields) {
    if (name !== group.field) continue;
    for (const wanted of group.values) if (equalBytes(wanted.slice(group.field.length + 1), value)) return true;
  }
  return false;
}

export class JournalMatches {
  private readonly level0: Level1[] = [];
  private current1: Level1 | null = null;
  private current2: Level2 | null = null;

  static matchIsValid(data: Uint8Array): boolean {
    if (data.length < 2) return false;
    if (data[0] === 0x5f && data[1] === 0x5f) return false;
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (c === 0x3d) return i > 0;
      if (c === 0x5f) continue;
      if (c >= 0x41 && c <= 0x5a) continue;
      if (c >= 0x30 && c <= 0x39) continue;
      return false;
    }
    return false;
  }

  addMatch(text: string | Uint8Array): MatchError | null {
    const data = typeof text === 'string' ? utf8(text) : text;
    if (!JournalMatches.matchIsValid(data)) return 'EINVAL';
    if (this.current1 === null) {
      this.current1 = { terms: [] };
      this.level0.push(this.current1);
    }
    if (this.current2 === null) {
      this.current2 = { groups: [] };
      this.current1.terms.push(this.current2);
    }
    const equals = data.indexOf(0x3d);
    const field = new TextDecoder().decode(data.slice(0, equals));
    for (const group of this.current2.groups) {
      for (const existing of group.values) if (equalBytes(existing, data)) return null;
    }
    const group = this.current2.groups.find(g => g.field === field);
    if (group) group.values.push(data);
    else this.current2.groups.push({ field, values: [data] });
    return null;
  }

  addConjunction(): void {
    if (this.level0.length === 0 || this.current1 === null) return;
    if (this.current1.terms.length === 0) return;
    this.current1 = null;
    this.current2 = null;
  }

  addDisjunction(): void {
    if (this.current1 === null || this.current2 === null) return;
    if (this.current2.groups.length === 0) return;
    this.current2 = null;
  }

  get empty(): boolean {
    return this.level0.length === 0;
  }

  matches(record: JournalRecord): boolean {
    for (const level1 of this.level0) {
      const satisfied = level1.terms.some(term => term.groups.every(group => groupMatches(record, group)));
      if (!satisfied) return false;
    }
    return true;
  }

  flush(): void {
    this.level0.length = 0;
    this.current1 = null;
    this.current2 = null;
  }
}
