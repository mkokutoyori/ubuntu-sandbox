import type { CommandSpec } from '../CommandTable';

export type TrieAction = (args: string[]) => string;

export interface CollectedRegistration {
  path: string;
  description: string;
  action: TrieAction;
  greedy: boolean;
  keywords?: ReadonlyArray<{ keyword: string; description: string }>;
  hidden: boolean;
}

export interface SpecCollector {
  register(path: string, description: string, action: TrieAction): void;
  registerGreedy(
    path: string, description: string, action: TrieAction,
    keywords?: ReadonlyArray<{ keyword: string; description: string } | string>,
  ): void;
  declare(entry: { path: string; description: string; run: TrieAction }): void;
  describeNode(path: string, description: string): void;
  neJamaisAnnoncer(path: string): void;
  addCompletionKeywords(path: string, keywords: readonly string[]): void;
  registerSuggestions(path: string, keywords: readonly unknown[]): void;
}

function normaliseKeywords(
  keywords?: ReadonlyArray<{ keyword: string; description: string } | string>,
): ReadonlyArray<{ keyword: string; description: string }> | undefined {
  if (!keywords) return undefined;
  return keywords.map(k => typeof k === 'string' ? { keyword: k, description: '' } : k);
}

export function collectRegistrations(
  register: (collector: SpecCollector) => void,
): CollectedRegistration[] {
  const collected: CollectedRegistration[] = [];
  const hidden = new Set<string>();
  const collector: SpecCollector = {
    register(path, description, action) {
      collected.push({ path, description, action, greedy: false, hidden: false });
    },
    registerGreedy(path, description, action, keywords) {
      collected.push({
        path, description, action, greedy: true,
        keywords: normaliseKeywords(keywords), hidden: false,
      });
    },
    declare(entry) {
      collected.push({
        path: entry.path, description: entry.description, action: entry.run,
        greedy: false, hidden: false,
      });
    },
    describeNode() { /* the socle derives node labels from its own specs */ },
    neJamaisAnnoncer(path) { hidden.add(path); },
    addCompletionKeywords() { /* the socle derives completion from declared children */ },
    registerSuggestions() { /* idem */ },
  };
  register(collector);
  return collected.map(entry => ({ ...entry, hidden: hidden.has(entry.path) }));
}

export interface SpecFromTrieOptions {
  modes: readonly string[];
  minPrivilege: number;
  restName?: string;
  restDescription?: string;
  skip?: (path: string) => boolean;
  keywordsFor?: (path: string) => ReadonlyArray<{ keyword: string; description: string }> | undefined;
}

export function specsFromTrieRegistrations(
  register: (collector: SpecCollector) => void,
  options: SpecFromTrieOptions,
): CommandSpec[] {
  const restName = options.restName ?? 'reste';
  const specs: CommandSpec[] = [];
  for (const entry of collectRegistrations(register)) {
    if (entry.hidden) continue;
    if (options.skip?.(entry.path)) continue;
    const words = entry.path.split(/\s+/).filter(Boolean);
    const path: CommandSpec['path'] = entry.greedy
      ? [...words, {
        name: restName, type: 'REST' as const, optional: true,
        description: options.restDescription ?? entry.description,
      }]
      : [...words];
    const run = (prefix: readonly string[]) => (_session: unknown, args: Record<string, string>) => {
      const rest = String(args[restName] ?? '').trim();
      return entry.action([...prefix, ...(rest.length === 0 ? [] : rest.split(/\s+/))]);
    };
    specs.push({
      id: words.join('-'),
      path,
      description: entry.description,
      modes: options.modes,
      minPrivilege: options.minPrivilege,
      run: run([]) as CommandSpec['run'],
    });
    for (const sub of entry.keywords ?? options.keywordsFor?.(entry.path) ?? []) {
      specs.push({
        id: [...words, sub.keyword].join('-'),
        path: [...words, sub.keyword, {
          name: restName, type: 'REST' as const, optional: true,
          description: options.restDescription ?? sub.description,
        }],
        description: sub.description,
        modes: options.modes,
        minPrivilege: options.minPrivilege,
        run: run([sub.keyword]) as CommandSpec['run'],
      });
    }
  }
  return specs;
}

export function pathsOf(specs: readonly CommandSpec[]): string[] {
  return specs.map(spec =>
    spec.path.filter((step): step is string => typeof step === 'string').join(' '));
}
