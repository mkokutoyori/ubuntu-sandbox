import type { CommandSpec } from '../CommandTable';
import type { ArgumentSpec } from '../ArgumentTypes';
import type { CliSession } from '../CliSession';

export type TrieAction = (args: string[], raw?: string) => string;

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
  restDescriptionFor?: (path: string) => string | undefined;
  restLiteralFor?: (path: string) => string | undefined;
  argumentFor?: (path: string) => ArgumentSpec | null | undefined;
  hiddenFor?: (path: string) => boolean;
  reachableWhenFor?: (path: string) => ((session: CliSession) => boolean) | undefined;
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
    if (options.skip?.(entry.path)) continue;
    const cache = entry.hidden || options.hiddenFor?.(entry.path) === true;
    const contexte = options.reachableWhenFor?.(entry.path);
    const words = entry.path.split(/\s+/).filter(Boolean);
    const declaredLabel = options.restDescriptionFor?.(entry.path)
      ?? options.restDescription;
    const restLiteral = options.restLiteralFor?.(entry.path);
    const declaredArgument = options.argumentFor?.(entry.path);
    const reste: ArgumentSpec = {
      name: restName, type: 'REST', optional: true,
      description: declaredLabel ?? entry.description,
      ...(restLiteral ? { literal: restLiteral } : {}),
      ...(declaredLabel === undefined && restLiteral === undefined
        ? { values: [] } : {}),
    };
    const argument = declaredArgument === undefined
      ? (entry.greedy ? reste : null) : declaredArgument;
    const path: CommandSpec['path'] = argument === null
      ? [...words] : [...words, argument];
    const nomValeur = argument === null ? restName : argument.name;
    const run = (prefix: readonly string[]) => (_session: unknown, args: Record<string, string>) => {
      const rest = String(args[nomValeur] ?? '').trim();
      const argv = [...prefix, ...(rest.length === 0 ? [] : rest.split(/\s+/))];
      return entry.action(argv, [...words, ...argv].join(' '));
    };
    specs.push({
      id: words.join('-'),
      path,
      description: entry.description,
      modes: options.modes,
      minPrivilege: options.minPrivilege,
      ...(cache ? { hidden: true } : {}),
      ...(contexte ? { reachableWhen: contexte } : {}),
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
        ...(cache ? { hidden: true } : {}),
        ...(contexte ? { reachableWhen: contexte } : {}),
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
