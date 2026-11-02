import type { PrefixAction } from './IpPrefixList';

export interface CommunityRule {
  readonly id: number;
  readonly action: PrefixAction;
  readonly kind: 'standard' | 'expanded';
  readonly communities: readonly string[];
  readonly regexp: string;
}

function regexpOf(source: string): RegExp | null {
  try {
    return new RegExp(source.replace(/_/g, '(?:^|$| )'));
  } catch {
    return null;
  }
}

export class CommunityList {
  private rules: readonly CommunityRule[] = [];

  constructor(readonly name: string) {}

  replace(rules: readonly CommunityRule[]): void {
    this.rules = [...rules].sort((a, b) => a.id - b.id);
  }

  evaluate(communities: readonly string[]): PrefixAction | null {
    const held = new Set(communities.map(value => value.toLowerCase()));
    const text = communities.join(' ');
    for (const rule of this.rules) {
      const matched = rule.kind === 'standard'
        ? rule.communities.length > 0 && rule.communities.every(value => held.has(value.toLowerCase()))
        : regexpOf(rule.regexp)?.test(text) === true;
      if (matched) return rule.action;
    }
    return null;
  }
}

export class CommunityListStore {
  private readonly lists = new Map<string, CommunityList>();

  upsert(name: string): CommunityList {
    let list = this.lists.get(name);
    if (list === undefined) {
      list = new CommunityList(name);
      this.lists.set(name, list);
    }
    return list;
  }

  get(name: string): CommunityList | undefined { return this.lists.get(name); }

  remove(name: string): boolean { return this.lists.delete(name); }
}
