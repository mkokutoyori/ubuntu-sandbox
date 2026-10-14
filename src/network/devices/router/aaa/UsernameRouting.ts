export const DEFAULT_SUFFIX_DELIMITERS = '@';

export interface DomainStrippingOptions {
  readonly rightToLeft?: boolean;
  readonly prefixDelimiters?: string;
  readonly suffixDelimiters?: string;
}

interface Ruleset {
  generic: boolean;
  rightToLeft: boolean;
  prefixDelimiters: string;
  suffixDelimiters: string;
  suffixes: string[];
}

export interface DirectedUsername {
  readonly user: string;
  readonly host: string;
}

export function splitDirected(username: string): DirectedUsername | null {
  const at = username.lastIndexOf('@');
  if (at <= 0 || at === username.length - 1) return null;
  return { user: username.slice(0, at), host: username.slice(at + 1) };
}

function firstDelimiterIndex(text: string, delimiters: string, rightToLeft: boolean): number {
  if (rightToLeft) {
    for (let i = text.length - 1; i >= 0; i--) if (delimiters.includes(text[i])) return i;
    return -1;
  }
  for (let i = 0; i < text.length; i++) if (delimiters.includes(text[i])) return i;
  return -1;
}

export class DomainStripping {
  private readonly rulesets = new Map<string, Ruleset>();

  private rulesetOf(vrf: string | undefined): Ruleset {
    const key = vrf ?? '';
    let ruleset = this.rulesets.get(key);
    if (!ruleset) {
      ruleset = {
        generic: false, rightToLeft: false, prefixDelimiters: '',
        suffixDelimiters: DEFAULT_SUFFIX_DELIMITERS, suffixes: [],
      };
      this.rulesets.set(key, ruleset);
    }
    return ruleset;
  }

  configure(vrf: string | undefined, options: DomainStrippingOptions): void {
    const ruleset = this.rulesetOf(vrf);
    ruleset.generic = true;
    ruleset.rightToLeft = options.rightToLeft === true;
    ruleset.prefixDelimiters = options.prefixDelimiters ?? '';
    ruleset.suffixDelimiters = options.suffixDelimiters ?? DEFAULT_SUFFIX_DELIMITERS;
  }

  addSuffix(vrf: string | undefined, suffix: string): void {
    const ruleset = this.rulesetOf(vrf);
    if (!ruleset.suffixes.includes(suffix)) ruleset.suffixes.push(suffix);
  }

  remove(vrf: string | undefined): void {
    this.rulesets.delete(vrf ?? '');
  }

  removeSuffix(vrf: string | undefined, suffix: string): void {
    const ruleset = this.rulesets.get(vrf ?? '');
    if (!ruleset) return;
    ruleset.suffixes = ruleset.suffixes.filter((s) => s !== suffix);
    if (!ruleset.generic && ruleset.suffixes.length === 0) this.rulesets.delete(vrf ?? '');
  }

  isEmpty(): boolean {
    return this.rulesets.size === 0;
  }

  apply(username: string, vrf: string | null): string {
    const ruleset = (vrf !== null ? this.rulesets.get(vrf) : undefined) ?? this.rulesets.get('');
    if (!ruleset) return username;
    let name = username;
    if (ruleset.prefixDelimiters.length > 0) {
      const at = firstDelimiterIndex(name, ruleset.prefixDelimiters, ruleset.rightToLeft);
      if (at >= 0) name = name.slice(at + 1);
    }
    if (ruleset.suffixes.length > 0) {
      for (const suffix of ruleset.suffixes) {
        for (const delimiter of ruleset.suffixDelimiters) {
          if (name.endsWith(delimiter + suffix) && name.length > suffix.length + 1) {
            return name.slice(0, name.length - suffix.length - 1);
          }
        }
      }
      return name;
    }
    const at = firstDelimiterIndex(name, ruleset.suffixDelimiters, ruleset.rightToLeft);
    return at > 0 ? name.slice(0, at) : name;
  }

  render(command: string): string[] {
    const lines: string[] = [];
    for (const [key, ruleset] of this.rulesets) {
      const vrf = key === '' ? '' : ` vrf ${key}`;
      if (ruleset.generic) {
        const parts = [command];
        if (ruleset.rightToLeft) parts.push('right-to-left');
        if (ruleset.prefixDelimiters.length > 0) parts.push(`prefix-delimiter ${ruleset.prefixDelimiters}`);
        if (ruleset.suffixDelimiters !== DEFAULT_SUFFIX_DELIMITERS) parts.push(`delimiter ${ruleset.suffixDelimiters}`);
        lines.push(parts.join(' ') + vrf);
      }
      for (const suffix of ruleset.suffixes) lines.push(`${command} strip-suffix ${suffix}${vrf}`);
    }
    return lines;
  }
}
