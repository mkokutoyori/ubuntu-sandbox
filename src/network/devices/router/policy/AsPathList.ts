import type { PrefixAction } from './IpPrefixList';

export interface AsPathRule {
  readonly id: number;
  readonly action: PrefixAction;
  readonly regexp: string;
}

function compile(regexp: string): RegExp | null {
  try {
    return new RegExp(regexp.replace(/_/g, '(?:^|$| )'));
  } catch {
    return null;
  }
}

export class AsPathList {
  private rules: readonly AsPathRule[] = [];

  constructor(readonly name: string) {}

  replace(rules: readonly AsPathRule[]): void {
    this.rules = [...rules].sort((a, b) => a.id - b.id);
  }

  evaluate(asPath: readonly number[]): PrefixAction | null {
    const text = asPath.join(' ');
    for (const rule of this.rules) {
      const pattern = compile(rule.regexp);
      if (pattern !== null && pattern.test(text)) return rule.action;
    }
    return null;
  }
}

export class AsPathListStore {
  private readonly lists = new Map<string, AsPathList>();

  upsert(name: string): AsPathList {
    let list = this.lists.get(name);
    if (list === undefined) {
      list = new AsPathList(name);
      this.lists.set(name, list);
    }
    return list;
  }

  get(name: string): AsPathList | undefined { return this.lists.get(name); }

  remove(name: string): boolean { return this.lists.delete(name); }
}
