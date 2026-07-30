/**
 * Le sous-ensemble XPath des requêtes du journal d'événements Windows.
 *
 * `wevtutil qe /q:` et `Get-WinEvent -FilterXml` prennent tous deux une
 * requête XPath 1.0, restreinte par Windows lui-même à une poignée de
 * formes. Écrire un évaluateur XPath complet serait hors sujet ; couvrir
 * ce qui s'écrit réellement ne l'est pas :
 *
 *     *[System[EventID=4624]]
 *     *[System[Provider[@Name='Dhcp-Client']]]
 *     *[System[(Level=1 or Level=2)]]
 *     *[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]
 *     *[EventData[Data[@Name='TargetUserName']='alice']]
 *
 * **Ce qui n'est pas reconnu est refusé, jamais ignoré.** Un filtre
 * qu'on ne sait pas appliquer et qui laisse tout passer est pire
 * qu'absent : il rend une réponse complète en la présentant comme
 * filtrée.
 */

/** L'entrée telle que l'évaluateur a besoin de la lire. */
export interface XPathEvent {
  eventId: number;
  source: string;
  entryType: string;
  timeGenerated: Date;
  data?: Record<string, string>;
}

export type XPathPredicate = (e: XPathEvent, now: number) => boolean;

export interface XPathParseResult {
  /** Le filtre, ou `null` si la requête n'a pas pu être comprise. */
  predicate: XPathPredicate | null;
  /** Ce qui a bloqué — repris tel quel dans le refus de `wevtutil`. */
  error?: string;
}

/**
 * Le niveau de sévérité que Windows associe à un événement.
 *
 * Les journaux de ce simulateur portent un `entryType` façon
 * `Get-EventLog` (`Information`, `Warning`, …) et non le `Level`
 * numérique du canal moderne : la table les rapproche. Les deux types
 * d'audit n'ont pas de niveau propre chez Windows — ils sont
 * `Information` (4), leur succès ou leur échec se lisant sur le
 * `Keywords`, pas sur le `Level`.
 */
const LEVEL_BY_ENTRY_TYPE: Record<string, number> = {
  critical: 1,
  error: 2,
  warning: 3,
  information: 4,
  successaudit: 4,
  failureaudit: 4,
};

export function levelOf(entryType: string): number {
  return LEVEL_BY_ENTRY_TYPE[entryType.toLowerCase()] ?? 4;
}

// ─── Analyse ────────────────────────────────────────────────────────

type Cmp = '=' | '!=' | '<=' | '>=' | '<' | '>';

const COMPARATORS: Cmp[] = ['!=', '<=', '>=', '=', '<', '>'];

/**
 * Découpe sur un opérateur logique de premier niveau, en respectant les
 * parenthèses et les crochets. `split` naïf casserait
 * `Data[@Name='a or b']`.
 */
function splitTopLevel(text: string, keyword: 'or' | 'and'): string[] | null {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0
      && text.slice(i, i + keyword.length).toLowerCase() === keyword
      // Le mot-clé doit être isolé : `Provider` contient « or », et le
      // découper dessus produirait deux fragments qui n'ont aucun sens.
      && /[\s)\]]/.test(text[i - 1] ?? ' ')
      && /[\s([]/.test(text[i + keyword.length] ?? ' ')) {
      parts.push(text.slice(last, i));
      i += keyword.length - 1;
      last = i + 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Retire une paire de parenthèses englobantes, s'il y en a une. */
function unwrap(text: string): string {
  let t = text.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0, closesAtEnd = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') { depth--; if (depth === 0 && i < t.length - 1) closesAtEnd = false; }
    }
    if (!closesAtEnd) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function compare(op: Cmp, left: string | number, right: string | number): boolean {
  if (op === '=') return String(left) === String(right);
  if (op === '!=') return String(left) !== String(right);
  const a = Number(left), b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return op === '<=' ? a <= b : op === '>=' ? a >= b : op === '<' ? a < b : a > b;
}

/** Sépare `gauche <op> droite` sur le premier comparateur de tête. */
function splitComparison(text: string): { lhs: string; op: Cmp; rhs: string } | null {
  let depth = 0, quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0) {
      for (const op of COMPARATORS) {
        if (text.startsWith(op, i)) {
          return {
            lhs: text.slice(0, i).trim(),
            op,
            rhs: text.slice(i + op.length).trim(),
          };
        }
      }
    }
  }
  return null;
}

/** Le contenu d'un `Nom[...]`, ou null si la forme ne correspond pas. */
function bracketed(text: string, name: string): string | null {
  const t = text.trim();
  const prefix = `${name}[`;
  if (!t.toLowerCase().startsWith(prefix.toLowerCase()) || !t.endsWith(']')) return null;
  return t.slice(prefix.length, -1);
}

/** Une condition à l'intérieur d'un bloc `System[...]`. */
function parseSystemTerm(term: string): XPathParseResult {
  const t = unwrap(term);

  const or = splitTopLevel(t, 'or');
  if (or) return combine(or.map(parseSystemTerm), 'or');
  const and = splitTopLevel(t, 'and');
  if (and) return combine(and.map(parseSystemTerm), 'and');

  // Provider[@Name='...'] — le nom de la source.
  const provider = bracketed(t, 'Provider');
  if (provider !== null) {
    const cmp = splitComparison(provider);
    if (!cmp || cmp.lhs.replace(/\s/g, '').toLowerCase() !== '@name') {
      return refuse(`Provider condition "${provider}" is not supported.`);
    }
    const want = stripQuotes(cmp.rhs);
    return { predicate: (e) => compare(cmp.op, e.source, want) };
  }

  // TimeCreated[timediff(@SystemTime) <= N] — l'âge en millisecondes.
  const timeCreated = bracketed(t, 'TimeCreated');
  if (timeCreated !== null) {
    const cmp = splitComparison(timeCreated);
    if (!cmp || !/^timediff\(\s*@SystemTime\s*\)$/i.test(cmp.lhs.trim())) {
      return refuse(`TimeCreated condition "${timeCreated}" is not supported.`);
    }
    const bound = Number(stripQuotes(cmp.rhs));
    if (Number.isNaN(bound)) return refuse(`"${cmp.rhs}" is not a number of milliseconds.`);
    return { predicate: (e, now) => compare(cmp.op, now - e.timeGenerated.getTime(), bound) };
  }

  // EventID / Level / EventRecordID — les comparaisons simples.
  const cmp = splitComparison(t);
  if (cmp) {
    const field = cmp.lhs.trim().toLowerCase();
    const want = stripQuotes(cmp.rhs);
    if (field === 'eventid') return { predicate: (e) => compare(cmp.op, e.eventId, want) };
    if (field === 'level') return { predicate: (e) => compare(cmp.op, levelOf(e.entryType), want) };
  }
  return refuse(`System condition "${t}" is not supported.`);
}

/** Une condition à l'intérieur d'un bloc `EventData[...]`. */
function parseEventDataTerm(term: string): XPathParseResult {
  const t = unwrap(term);

  const or = splitTopLevel(t, 'or');
  if (or) return combine(or.map(parseEventDataTerm), 'or');
  const and = splitTopLevel(t, 'and');
  if (and) return combine(and.map(parseEventDataTerm), 'and');

  // Data[@Name='X']='Y' — le champ nommé, la forme de loin la plus utile.
  const named = /^Data\[\s*@Name\s*=\s*(['"])(.*?)\1\s*\]\s*(!=|=)\s*(.*)$/i.exec(t);
  if (named) {
    const field = named[2];
    const op = named[3] as Cmp;
    const want = stripQuotes(named[4]);
    return { predicate: (e) => compare(op, e.data?.[field] ?? '', want) };
  }

  // Data[@Name='X'] seul — le champ existe, quelle que soit sa valeur.
  const exists = /^Data\[\s*@Name\s*=\s*(['"])(.*?)\1\s*\]$/i.exec(t);
  if (exists) {
    const field = exists[2];
    return { predicate: (e) => e.data?.[field] !== undefined };
  }

  // Data='Y' — n'importe quel champ portant cette valeur.
  const anyValue = splitComparison(t);
  if (anyValue && anyValue.lhs.trim().toLowerCase() === 'data') {
    const want = stripQuotes(anyValue.rhs);
    return {
      predicate: (e) => Object.values(e.data ?? {})
        .some((v) => compare(anyValue.op, v, want)),
    };
  }
  return refuse(`EventData condition "${t}" is not supported.`);
}

function refuse(error: string): XPathParseResult {
  return { predicate: null, error };
}

function combine(parts: XPathParseResult[], mode: 'or' | 'and'): XPathParseResult {
  const failed = parts.find((p) => p.predicate === null);
  if (failed) return failed;
  const preds = parts.map((p) => p.predicate!);
  return {
    predicate: (e, now) => mode === 'or'
      ? preds.some((p) => p(e, now))
      : preds.every((p) => p(e, now)),
  };
}

/**
 * Analyse une requête `*[...]`.
 *
 * La forme `*` seule (ou vide) ne filtre rien, ce qui est légitime : le
 * vrai `wevtutil` l'accepte et rend tout. Toute autre forme non reconnue
 * est refusée.
 */
export function parseEventXPath(query: string): XPathParseResult {
  const q = query.trim();
  if (q === '' || q === '*') return { predicate: () => true };

  // Le découpage vient d'abord, parce que Microsoft documente la forme
  // `*[System[...]] and *[EventData[...]]` — deux sélecteurs complets
  // joints au premier niveau. Déballer avant de découper prendrait tout
  // ce qui sépare le premier `*[` du dernier `]` pour un seul corps.
  const topOr = splitTopLevel(q, 'or');
  if (topOr) return combine(topOr.map(parseEventXPath), 'or');
  const topAnd = splitTopLevel(q, 'and');
  if (topAnd) return combine(topAnd.map(parseEventXPath), 'and');

  const body = bracketed(q, '*');
  if (body === null) return refuse(`Query "${q}" is not a supported event selector.`);

  const t = unwrap(body);
  const or = splitTopLevel(t, 'or');
  if (or) return combine(or.map((p) => parseEventXPath(`*[${p}]`)), 'or');
  const and = splitTopLevel(t, 'and');
  if (and) return combine(and.map((p) => parseEventXPath(`*[${p}]`)), 'and');

  const system = bracketed(t, 'System');
  if (system !== null) return parseSystemTerm(system);

  const eventData = bracketed(t, 'EventData');
  if (eventData !== null) return parseEventDataTerm(eventData);

  return refuse(`Selector "${t}" is not supported. Use System[...] or EventData[...].`);
}
