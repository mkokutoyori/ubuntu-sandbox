import { UsageError } from "../errors";
import type { CommandRegistry } from "../registry/command-registry";
import type { ICommand } from "../command/types";
import type { CliCommand } from "./types";

/**
 * Résolution préfixe-unique d'un mot dans un registre — pilier des CLI
 * vendeur (`sh` = `show`, `conf t` = `configure terminal`) et de la
 * future auto-complétion (mêmes règles). Insensible à la casse.
 */
export interface PrefixMatch {
  readonly status: 'ok' | 'ambiguous' | 'not-found';
  readonly command?: ICommand;
  /** Candidats en cas d'ambiguïté ou d'absence — utile pour l'aide `?`. */
  readonly candidates?: readonly string[];
}

export function matchByPrefix(registry: CommandRegistry, word: string, currentMode?: string): PrefixMatch {
  const needle = word.toLowerCase();
  const all = registry.list();
  const visible = currentMode
    ? all.filter((d) => {
        const cmd = registry.resolve(d.name);
        const modes = (cmd as CliCommand | undefined)?.allowedModes;
        return !modes || modes.includes(currentMode);
      })
    : all;

  const exact = visible.find((d) => d.name.toLowerCase() === needle);
  if (exact) return { status: 'ok', command: registry.resolve(exact.name)! };

  const prefix = visible.filter((d) => d.name.toLowerCase().startsWith(needle));
  const aliases = visible
    .flatMap((d) => (d.aliases ?? []).map((a) => ({ alias: a, canonical: d.name })))
    .filter((p) => p.alias.toLowerCase().startsWith(needle));

  const namesFound = new Set<string>();
  for (const d of prefix) namesFound.add(d.name);
  for (const a of aliases) namesFound.add(a.canonical);

  if (namesFound.size === 0) return { status: 'not-found', candidates: visible.map((d) => d.name) };
  if (namesFound.size > 1) return { status: 'ambiguous', candidates: [...namesFound].sort() };

  const canonical = [...namesFound][0];
  return { status: 'ok', command: registry.resolve(canonical)! };
}

/**
 * Enveloppe `matchByPrefix` qui lève une `UsageError` en cas d'ambiguïté
 * — utilisée par l'interpréteur pour interrompre la ligne courante avec
 * un message clair (parité message côté vendeur reste la responsabilité
 * de l'appelant si un format vendor-exact est requis).
 */
export function resolveOrThrow(registry: CommandRegistry, word: string, currentMode?: string): ICommand {
  const match = matchByPrefix(registry, word, currentMode);
  if (match.status === 'ok') return match.command!;
  if (match.status === 'ambiguous') {
    throw new UsageError(`ambigu : "${word}" ↦ ${match.candidates!.join(' | ')}`);
  }
  throw new UsageError(`inconnu : "${word}"`);
}
