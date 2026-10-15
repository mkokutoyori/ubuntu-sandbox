import { sshOptionAssignment } from '../SshClientOptions';

export interface ClientConfigMatchContext {
  readonly originalHost: string;
  readonly hostName: string;
  readonly user: string;
  readonly localUser: string;
}

export interface ClientConfigInclude {
  readonly path: string;
  readonly text: string;
}

export interface ClientConfigSource {
  readonly readFile: (path: string) => string | null;
  readonly expandInclude: (pattern: string) => readonly ClientConfigInclude[];
}

type Criterion =
  | { readonly kind: 'all' }
  | { readonly kind: 'host' | 'originalhost' | 'user' | 'localuser'; readonly patterns: string };

interface Condition {
  readonly criteria: readonly Criterion[];
  readonly hostPatterns: string | null;
}

interface ConfigBlock {
  readonly conditions: readonly Condition[];
  readonly directives: string[];
}

const MAX_INCLUDE_DEPTH = 16;

function unquote(word: string): string {
  return word.length >= 2 && word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word;
}

function words(text: string): string[] {
  const found: string[] = [];
  const pattern = /"[^"]*"|\S+/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) found.push(unquote(match[0]));
  return found;
}

export function matchesPatternList(list: string, candidate: string, caseInsensitive = true): boolean {
  const subject = caseInsensitive ? candidate.toLowerCase() : candidate;
  let matched = false;
  for (const raw of list.split(',').flatMap((piece) => piece.trim().split(/\s+/)).filter(Boolean)) {
    const negated = raw.startsWith('!');
    const body = caseInsensitive ? raw.slice(negated ? 1 : 0).toLowerCase() : raw.slice(negated ? 1 : 0);
    const expression = new RegExp(`^${body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    if (!expression.test(subject)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function criterionHolds(criterion: Criterion, context: ClientConfigMatchContext): boolean {
  switch (criterion.kind) {
    case 'all': return true;
    case 'host': return matchesPatternList(criterion.patterns, context.hostName);
    case 'originalhost': return matchesPatternList(criterion.patterns, context.originalHost);
    case 'user': return matchesPatternList(criterion.patterns, context.user, false);
    case 'localuser': return matchesPatternList(criterion.patterns, context.localUser, false);
  }
}

function conditionHolds(condition: Condition, context: ClientConfigMatchContext): boolean {
  if (condition.hostPatterns !== null && !matchesPatternList(condition.hostPatterns, context.originalHost)) return false;
  return condition.criteria.every((criterion) => criterionHolds(criterion, context));
}

function parseMatchCriteria(rest: string): Criterion[] | null {
  const tokens = words(rest);
  const criteria: Criterion[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const keyword = tokens[at].toLowerCase();
    if (keyword === 'all') { criteria.push({ kind: 'all' }); continue; }
    if (keyword === 'canonical' || keyword === 'final') continue;
    if (keyword === 'host' || keyword === 'originalhost' || keyword === 'user' || keyword === 'localuser') {
      const patterns = tokens[at + 1];
      if (patterns === undefined) return null;
      criteria.push({ kind: keyword, patterns });
      at += 1;
      continue;
    }
    return null;
  }
  return criteria;
}

export class SshClientConfigFile {
  private constructor(private readonly blocks: readonly ConfigBlock[]) {}

  static readonly empty = new SshClientConfigFile([]);

  static parse(text: string, source: ClientConfigSource | null = null, depth = 0): SshClientConfigFile {
    return new SshClientConfigFile(SshClientConfigFile.parseBlocks(text, source, depth, []));
  }

  private static parseBlocks(
    text: string, source: ClientConfigSource | null, depth: number, inherited: readonly Condition[],
  ): ConfigBlock[] {
    const blocks: ConfigBlock[] = [];
    let current: ConfigBlock = { conditions: inherited, directives: [] };
    blocks.push(current);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const assignment = /^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
      if (assignment === null) continue;
      const keyword = assignment[1].toLowerCase();
      const rest = assignment[2].trim();
      if (keyword === 'host') {
        current = { conditions: [...inherited, { criteria: [], hostPatterns: words(rest).join(' ') }], directives: [] };
        blocks.push(current);
        continue;
      }
      if (keyword === 'match') {
        const criteria = parseMatchCriteria(rest);
        current = { conditions: [...inherited, { criteria: criteria ?? [{ kind: 'host', patterns: '!*' }], hostPatterns: null }], directives: [] };
        blocks.push(current);
        continue;
      }
      if (keyword === 'include') {
        if (source !== null && depth < MAX_INCLUDE_DEPTH) {
          for (const pattern of words(rest)) {
            for (const file of source.expandInclude(pattern)) {
              blocks.push(...SshClientConfigFile.parseBlocks(file.text, source, depth + 1, current.conditions));
            }
          }
        }
        continue;
      }
      current.directives.push(`${keyword} ${rest}`);
    }
    return blocks;
  }

  optionValues(context: ClientConfigMatchContext): string[] {
    const first = this.collect(context);
    const hostName = first.find((line) => line.startsWith('hostname '))?.slice('hostname '.length).trim();
    const resolved = hostName === undefined ? context : { ...context, hostName: hostName.replace(/%h/g, context.originalHost) };
    return resolved === context ? first : this.collect(resolved);
  }

  private collect(context: ClientConfigMatchContext): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) {
      if (block.directives.length === 0) continue;
      if (block.conditions.every((condition) => conditionHolds(condition, context))) lines.push(...block.directives);
    }
    return lines.filter((line) => sshOptionAssignment(line) !== null);
  }
}
