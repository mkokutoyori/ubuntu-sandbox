import { UsageError } from "../errors";
import type { CliPipeFilter } from "./types";

/**
 * Tokenisation d'une ligne CLI vendeur (IOS/VRP) — grammaire minimale :
 *  - espaces séparent les mots ;
 *  - guillemets simples ou doubles regroupent (les guillemets sont
 *    consommés, leur contenu reste littéral) ;
 *  - un unique filtre pipe terminal `| include|exclude|section|begin
 *    <pattern>` est extrait à part et retiré des mots ;
 *  - AUCUNE substitution de variable, AUCUN pipeline multi-étages,
 *    AUCUNE redirection, AUCUN opérateur logique.
 *
 * Trois formes de pipe usuelles :
 *   `show ver | inc IOS`
 *   `show run | section interface`
 *   `show log | exclude debug`
 */
export interface CliTokenization {
  readonly argv: readonly string[];
  readonly filter?: CliPipeFilter;
}

const FILTER_OPS = new Set<CliPipeFilter['op']>(['include', 'exclude', 'section', 'begin']);

export function tokenizeCliLine(raw: string): CliTokenization {
  const words = splitRespectingQuotes(raw);
  if (words.length === 0) return { argv: [] };

  const pipeIdx = words.indexOf('|');
  if (pipeIdx === -1) return { argv: words };

  const before = words.slice(0, pipeIdx);
  const rest = words.slice(pipeIdx + 1);
  if (rest.length < 2) {
    throw new UsageError('filtre pipe attendu : | include|exclude|section|begin <motif>');
  }
  const op = rest[0].toLowerCase() as CliPipeFilter['op'];
  if (!FILTER_OPS.has(op)) {
    throw new UsageError(`filtre pipe inconnu : ${rest[0]} (attendu : include, exclude, section, begin)`);
  }
  // Un `include` peut porter un motif à plusieurs mots — on rejoint le
  // reste en un seul motif (comme le fait le vrai IOS).
  const pattern = rest.slice(1).join(' ');
  if (before.length === 0) {
    throw new UsageError('un filtre pipe doit suivre une commande');
  }
  return { argv: before, filter: { op, pattern } };
}

function splitRespectingQuotes(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let current = '';
  let hasContent = false;
  let quote: '"' | "'" | null = null;
  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) { quote = null; hasContent = true; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasContent = true; continue; }
    if (/\s/.test(ch)) {
      if (hasContent) { out.push(current); current = ''; hasContent = false; }
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (quote) throw new UsageError(`guillemet non fermé : ${quote}`);
  if (hasContent) out.push(current);
  return out;
}

/**
 * Applique le filtre à un texte multi-lignes. Réutilisé par l'hôte
 * (`CliInterpreter`) après exécution de la commande — jamais par les
 * commandes elles-mêmes (elles ignorent qu'un filtre existe).
 */
export function applyCliPipeFilter(text: string, filter: CliPipeFilter): string {
  const lines = text.split('\n');
  let rx: RegExp;
  try {
    rx = new RegExp(filter.pattern);
  } catch {
    // IOS accepte des motifs invalides silencieusement en no-op — mieux
    // vaut lever une erreur métier propre côté kernel.
    throw new UsageError(`motif invalide dans le filtre pipe : ${filter.pattern}`);
  }
  switch (filter.op) {
    case 'include': return lines.filter((l) => rx.test(l)).join('\n');
    case 'exclude': return lines.filter((l) => !rx.test(l)).join('\n');
    case 'begin': {
      const first = lines.findIndex((l) => rx.test(l));
      return first === -1 ? '' : lines.slice(first).join('\n');
    }
    case 'section': {
      // Bloc contigu autour de chaque ligne matchée jusqu'à une ligne
      // d'indentation ≤ à celle du match. Approximation raisonnable de
      // ce que fait IOS pour `show running-config | section interface`.
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!rx.test(lines[i])) continue;
        const base = leadingSpaces(lines[i]);
        out.push(lines[i]);
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') { out.push(lines[j]); continue; }
          if (leadingSpaces(lines[j]) <= base) break;
          out.push(lines[j]);
        }
      }
      return out.join('\n');
    }
  }
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}
