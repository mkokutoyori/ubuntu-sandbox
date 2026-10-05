export interface SshdConfigSource {
  readFile(path: string): string | null;
  globExpand?(pattern: string, cwd: string): string[];
}

export const SSHD_CONFIG_PATH = '/etc/ssh/sshd_config';

const SSHD_DIRECTORY = '/etc/ssh';
const MAX_INCLUDE_DEPTH = 16;

const ACCUMULATING_KEYWORDS: ReadonlySet<string> = new Set([
  'port', 'listenaddress', 'hostkey', 'hostcertificate',
  'allowusers', 'denyusers', 'allowgroups', 'denygroups', 'acceptenv',
]);

interface Scope {
  readonly header: string | null;
  readonly lines: string[];
}

function includeTargets(argument: string): string[] {
  return argument.split(/\s+/).filter((word) => word !== '').map((word) => (
    word.startsWith('/') ? word : `${SSHD_DIRECTORY}/${word}`
  ));
}

function walk(
  source: SshdConfigSource, path: string, depth: number,
  scopes: Scope[], entry: Scope,
): void {
  if (depth > MAX_INCLUDE_DEPTH) return;
  const content = source.readFile(path);
  if (content === null) return;
  let current = entry;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const word = /^(\S+)\s*(.*)$/.exec(line);
    if (word === null) continue;
    const keyword = word[1].toLowerCase();
    if (keyword === 'include') {
      for (const pattern of includeTargets(word[2])) {
        for (const file of source.globExpand?.(pattern, '/') ?? []) walk(source, file, depth + 1, scopes, current);
      }
      continue;
    }
    if (keyword === 'match') {
      current = { header: line, lines: [] };
      scopes.push(current);
      continue;
    }
    current.lines.push(line);
  }
}

function firstValueWins(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const word = /^(\S+)\s*(.*)$/.exec(line);
    if (word === null) continue;
    const keyword = word[1].toLowerCase();
    if (!ACCUMULATING_KEYWORDS.has(keyword)) {
      const identity = keyword === 'subsystem' ? `subsystem ${word[2].split(/\s+/)[0]}` : keyword;
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    kept.push(line);
  }
  return kept;
}

export function readSshdConfig(source: SshdConfigSource, path = SSHD_CONFIG_PATH): string {
  const global: Scope = { header: null, lines: [] };
  const scopes: Scope[] = [global];
  walk(source, path, 0, scopes, global);
  const out: string[] = [];
  for (const scope of scopes) {
    if (scope.header !== null) out.push(scope.header);
    out.push(...firstValueWins(scope.lines));
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
