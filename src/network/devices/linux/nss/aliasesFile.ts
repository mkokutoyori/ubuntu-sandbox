/**
 * `/etc/aliases` (aliases(5)) parsing and expansion.
 *
 * Shared by the `files` NSS source (so `getent aliases` answers) and by
 * SMTP local delivery (so a message to an alias actually reaches the
 * real recipients) — one parser, one notion of the format.
 */
import type { NssAliasEntry } from './types';

/**
 * `name: dest[, dest...]`, `#` comments, and continuation lines that
 * start with whitespace and extend the previous entry.
 */
export function parseAliasesFile(raw: string | null): NssAliasEntry[] {
  if (raw === null) return [];
  const out: NssAliasEntry[] = [];
  let current: NssAliasEntry | null = null;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    if (line.trim() === '') continue;
    if (/^\s/.test(rawLine) && current) {
      for (const d of line.split(',')) {
        const t = d.trim();
        if (t) current.members.push(t);
      }
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (current) out.push(current);
    current = {
      name: line.slice(0, colon).trim(),
      members: line.slice(colon + 1).split(',').map(d => d.trim()).filter(Boolean),
    };
  }
  if (current) out.push(current);
  return out;
}

/**
 * Expand a recipient through the alias table, recursively, the way a
 * real Postfix/Sendmail does.
 *
 * An address that matches no alias expands to itself. A cycle
 * (`a: b` / `b: a`) terminates on the already-visited name rather than
 * recursing forever, and `root: root` therefore means "deliver to the
 * real root mailbox" — both are real aliases(5) behaviours.
 *
 * Only the local part is matched: aliases are local names, so
 * `postmaster@example.com` is looked up as `postmaster`.
 */
export function expandAlias(
  entries: readonly NssAliasEntry[],
  address: string,
  localPartOf: (a: string) => string,
): string[] {
  const byName = new Map<string, NssAliasEntry>();
  for (const e of entries) byName.set(e.name.toLowerCase(), e);

  const out: string[] = [];
  const seen = new Set<string>();

  const walk = (addr: string): void => {
    const local = localPartOf(addr);
    const alias = byName.get(local);
    if (!alias || seen.has(local)) {
      if (!out.includes(addr)) out.push(addr);
      return;
    }
    seen.add(local);
    for (const dest of alias.members) walk(dest);
  };

  walk(address);
  return out;
}
