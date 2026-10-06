export interface ProfileNode {
  readonly name: string;
  readonly value: string | null;
  readonly children: readonly ProfileNode[] | null;
}

export interface ProfileSource {
  readFile(path: string): string | null;
  listDirectory(path: string): readonly string[] | null;
}

const MAX_INCLUDE_DEPTH = 8;

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, (_match, escaped: string) => {
      switch (escaped) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'b': return '\b';
        default: return escaped;
      }
    });
  }
  return trimmed;
}

interface Frame {
  readonly name: string;
  readonly children: ProfileNode[];
}

function parseInto(
  text: string, source: ProfileSource, roots: ProfileNode[], depth: number,
): void {
  const stack: Frame[] = [];
  let sectionChildren: ProfileNode[] | null = null;
  let sectionName: string | null = null;
  const closeSection = (): void => {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const parent = stack.length > 0 ? stack[stack.length - 1].children : sectionChildren;
      parent?.push({ name: frame.name, value: null, children: frame.children });
    }
    if (sectionName !== null && sectionChildren !== null) {
      roots.push({ name: sectionName, value: null, children: sectionChildren });
    }
    sectionName = null;
    sectionChildren = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const include = /^(include|includedir)\s+(.+)$/.exec(line);
    if (include !== null && sectionName === null) {
      if (depth >= MAX_INCLUDE_DEPTH) continue;
      const target = include[2].trim();
      if (include[1] === 'include') {
        const content = source.readFile(target);
        if (content !== null) parseInto(content, source, roots, depth + 1);
      } else {
        const names = source.listDirectory(target) ?? [];
        for (const name of [...names].sort()) {
          if (!/^[A-Za-z0-9_-]+$|\.conf$/.test(name)) continue;
          const content = source.readFile(`${target.replace(/\/$/, '')}/${name}`);
          if (content !== null) parseInto(content, source, roots, depth + 1);
        }
      }
      continue;
    }
    const section = /^\[([^\]]+)\]/.exec(line);
    if (section !== null) {
      closeSection();
      sectionName = section[1].trim();
      sectionChildren = [];
      continue;
    }
    if (sectionChildren === null) continue;
    if (line === '}') {
      const frame = stack.pop();
      if (frame !== undefined) {
        const parent = stack.length > 0 ? stack[stack.length - 1].children : sectionChildren;
        parent.push({ name: frame.name, value: null, children: frame.children });
      }
      continue;
    }
    const relation = /^(\*?)\s*([^=\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (relation === null) continue;
    const name = relation[2];
    const rest = relation[3].trim();
    if (rest === '{') {
      stack.push({ name, children: [] });
      continue;
    }
    const target = stack.length > 0 ? stack[stack.length - 1].children : sectionChildren;
    target.push({ name, value: unquote(rest), children: null });
  }
  closeSection();
}

export class Krb5Profile {
  private constructor(private readonly roots: readonly ProfileNode[]) {}

  static parse(texts: readonly string[], source: ProfileSource): Krb5Profile {
    const roots: ProfileNode[] = [];
    for (const text of texts) parseInto(text, source, roots, 0);
    return new Krb5Profile(roots);
  }

  static empty(): Krb5Profile {
    return new Krb5Profile([]);
  }

  private find(path: readonly string[]): ProfileNode[] {
    let level: readonly ProfileNode[] = this.roots;
    for (let index = 0; index < path.length - 1; index++) {
      const next: ProfileNode[] = [];
      for (const node of level) {
        if (node.name === path[index] && node.children !== null) next.push(...node.children);
      }
      level = next;
    }
    return level.filter((node) => node.name === path[path.length - 1]);
  }

  strings(...path: string[]): string[] {
    return this.find(path).filter((node) => node.value !== null).map((node) => node.value!);
  }

  string(...path: string[]): string | null {
    return this.strings(...path)[0] ?? null;
  }

  subsectionNames(...path: string[]): string[] {
    return this.find(path).filter((node) => node.children !== null).map((node) => node.name);
  }

  hasSubsection(...path: string[]): boolean {
    return this.find(path).some((node) => node.children !== null);
  }

  boolean(fallback: boolean, ...path: string[]): boolean {
    const value = this.string(...path);
    if (value === null) return fallback;
    const lowered = value.toLowerCase();
    if (['y', 'yes', 'true', 't', '1', 'on'].includes(lowered)) return true;
    if (['n', 'no', 'false', 'nil', '0', 'off'].includes(lowered)) return false;
    return fallback;
  }
}
