/**
 * Shared CLI Utilities — DRY extraction for Cisco & Huawei shells
 *
 * Eliminates duplicated pipe filtering, error messages, and interface
 * resolution logic across CiscoIOSShell, CiscoSwitchShell, and HuaweiVRPShell.
 */

// ─── Cisco CLI Error Messages ──────────────────────────────────────

export const CISCO_ERRORS = {
  AMBIGUOUS: (cmd: string) => `% Ambiguous command: "${cmd}"`,
  INCOMPLETE: '% Incomplete command.',
  INVALID_INPUT: "% Invalid input detected at '^' marker.",
  UNRECOGNIZED: (cmd: string) => `% Unrecognized command "${cmd}"`,
  // IOS n'émet jamais « % Unrecognized command » : un `?` sans
  // correspondance rend le même refus que n'importe quelle saisie
  // fautive. Le nom est conservé pour ses appelants.
  UNRECOGNIZED_HELP: '% Invalid input detected at \'^\' marker.',
  // Le refus d'IOS quand la commande EXISTE mais que l'interface
  // selectionnee ne la porte pas — `ip helper-address` sur un port L2
  // d'un Catalyst. Il etait ecrit a la main a ses points d'usage.
  NOT_APPLICABLE_INTERFACE: '% Command rejected: not applicable on this interface.',
} as const;

/**
 * Huawei VRP never uses Cisco's `%` prefix, and unlike IOS (which only
 * shows a caret for "Invalid input"), VRP uniformly echoes the offending
 * line with a `^` marker for ambiguous/incomplete/unrecognized commands
 * alike — e.g. `Error: Unrecognized command found at '^' position.`
 * followed by the input line and a caret under the failing token.
 * `pos` defaults to the end of `input` (matches VRP's own behaviour for
 * "expected more here" cases like a bare `screen-length`).
 */
function formatVrpPositionalError(reason: string, input: string, pos: number = input.length): string {
  const marker = ' '.repeat(Math.max(0, pos)) + '^';
  return `Error: ${reason} found at '^' position.\n${input}\n${marker}`;
}

export const HUAWEI_ERRORS = {
  AMBIGUOUS: (input: string, pos?: number) => formatVrpPositionalError('Ambiguous command', input, pos),
  INCOMPLETE: (input: string, pos?: number) => formatVrpPositionalError('Incomplete command', input, pos),
  UNRECOGNIZED: (input: string, pos?: number) => formatVrpPositionalError('Unrecognized command', input, pos),
  WRONG: (input: string, pos?: number) => formatVrpPositionalError('Wrong parameter', input, pos),
  TOO_MANY: (input: string, pos?: number) => formatVrpPositionalError('Too many parameters', input, pos),
} as const;

/**
 * VRP n'a que quatre messages positionnels, et ils portent TOUS l'echo
 * de la ligne et le curseur. Les gestionnaires rendent la chaine nue —
 * 237 sites pour le seul `Error: Incomplete command.` — et trois
 * orthographes coexistent pour le parametre errone, dont une qui annonce
 * un curseur (« found at '^' position ») sans en montrer aucun.
 *
 * Les corriger un par un etait exclu et aurait laissé le 238e recommencer :
 * la mise en forme se fait au POINT DE SORTIE, une fois, la ou la ligne
 * tapee et le nombre de mots-cles reconnus sont encore connus.
 *
 * Ce qui n'est pas une des quatre familles est laisse tel quel : un
 * message propre a une commande (`Error: OSPF is not configured.`) n'a
 * pas de position a montrer, et lui en inventer une serait un mensonge
 * de plus.
 */
export function normaliserErreurVrp(
  sortie: string,
  ligne: string,
  nbMotsCles = 0,
): string {
  if (!sortie.startsWith('Error: ')) return sortie;
  if (sortie.includes('\n')) return sortie;

  const tete = sortie.slice('Error: '.length).replace(/\.$/, '');
  if (/^Incomplete command/.test(tete)) return HUAWEI_ERRORS.INCOMPLETE(ligne);
  if (/^Unrecognized command/.test(tete)) return HUAWEI_ERRORS.UNRECOGNIZED(ligne);
  if (/^(Wrong parameter|Invalid (IP|OSPF)|Expected )/.test(tete)) {
    return formatVrpPositionalError('Wrong parameter', ligne, positionArgument(ligne, nbMotsCles));
  }
  return sortie;
}

/**
 * Le mot en trop, quand la commande declare un plafond d'arguments.
 *
 * Le plafond est OPTIONNEL et n'est pose que la ou les formes legitimes
 * sont connues et closes : plafonner a l'aveugle refuserait une forme
 * valide, ce qui serait pire que le silence d'aujourd'hui. Une commande
 * sans plafond declare se comporte exactement comme avant.
 */
export function tropDeParametres(
  resultat: { node?: { maxArgs?: number }; args: readonly string[]; matchedKeywords: readonly string[] },
  ligne: string,
): string | null {
  const max = resultat.node?.maxArgs;
  if (max === undefined || resultat.args.length <= max) return null;
  return HUAWEI_ERRORS.TOO_MANY(ligne, positionArgument(ligne, resultat.matchedKeywords.length + max));
}

/** Le debut du premier argument : la ou un parametre errone se trouve. */
function positionArgument(ligne: string, nbMotsCles: number): number {
  const spans: number[] = [];
  const re = /\S+/g;
  for (let m = re.exec(ligne); m !== null; m = re.exec(ligne)) spans.push(m.index);
  return spans[nbMotsCles] ?? spans[spans.length - 1] ?? ligne.trimEnd().length;
}

/** Une adresse IPv4 en notation pointee, quatre octets dans les bornes. */
export function estAdresseIPv4(valeur: string): boolean {
  const parts = valeur.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Le nom qu'un port PORTE a l'ecran. Les ports sont ranges sous leur nom
 * court (`GE0/0/0`), qui est interne : VRP n'affiche jamais que le nom
 * complet, l'invite comprise. L'expansion etait ecrite en ligne dans
 * deux vues et absente des deux autres, si bien que la meme interface
 * s'appelait `GE0/0/0` ici et `GigabitEthernet0/0/0` la.
 */
export function huaweiDisplayInterfaceName(interne: string): string {
  return interne.startsWith('GE') ? interne.replace(/^GE/, 'GigabitEthernet') : interne;
}

/** Ce que la vue RIP de VRP retient hors du moteur commun. */
export interface HuaweiRipExtras {
  autoSummary?: boolean;
  importRoute?: string[];
  silentInterfaces?: Set<string>;
  updateSec?: number;
  timeoutSec?: number;
  gcSec?: number;
  defaultOriginate?: boolean;
  maximumPaths?: number;
  checkZero?: boolean;
  verifySource?: boolean;
}

/**
 * Le CLI ecrivait ce sac et personne ne le lisait : `undo summary` etait
 * accepte, stocke, et absent de la configuration rendue. Un seul
 * accesseur pour celui qui ecrit et celui qui rend, sinon les deux
 * finissent par ne plus parler du meme objet.
 */
export function huaweiRipExtras(router: unknown): HuaweiRipExtras {
  const r = router as { _huaweiRipExtras?: HuaweiRipExtras };
  return r._huaweiRipExtras ?? (r._huaweiRipExtras = {});
}

/**
 * Le `#` d'une configuration VRP separe les blocs, et c'est lui qui
 * ramene en vue systeme quand la configuration est REJOUEE — ce que fait
 * l'import d'une topologie. Il etait pousse a la main en une vingtaine
 * d'endroits, donc deux manquaient : `ip route-static` sortait a
 * l'interieur du bloc `acl`, et le bloc `aaa` a l'interieur du bloc
 * OSPF. Retapees, ces lignes tombaient.
 *
 * La regle est mecanique et se pose une seule fois : on quitte un bloc
 * des qu'une ligne de premier niveau suit une ligne indentee, et il faut
 * alors un `#`. Deux lignes de premier niveau qui se suivent n'en
 * demandent pas — VRP groupe ses commandes autonomes.
 */
export function normaliserBlocsVrp(lignes: readonly string[]): string[] {
  const out: string[] = [];
  for (const ligne of lignes) {
    const premierNiveau = ligne.length > 0 && !/^\s/.test(ligne) && ligne !== '#';
    const precedente = out[out.length - 1];
    if (premierNiveau && precedente !== undefined && /^\s/.test(precedente)) {
      out.push('#');
    }
    if (ligne === '#' && precedente === '#') continue;
    out.push(ligne);
  }
  return out;
}

/**
 * `undo X` existe si et seulement si `X` se configure dans cette vue :
 * c'est la regle de VRP, et le trie de la vue sait deja y repondre. Le
 * fourre-tout `undo` rendait la main en silence sur n'importe quel mot,
 * si bien qu'une faute de frappe passait pour un succes — or le silence
 * est la seule confirmation que VRP donne quand tout va bien.
 *
 * La question posee ici est « ce mot existe-t-il », et elle porte sur le
 * PREMIER mot seulement. Interroger la forme entiere reviendrait a faire
 * dependre le refus de l'arite du positif : `ip pool` est enregistre
 * sans argument, donc `undo ip pool P1` serait refuse alors qu'il est
 * legitime. Un mot en trop derriere une tete valide est une autre erreur
 * (`Too many parameters`), traitee ailleurs.
 *
 * Rend `null` quand l'appelant peut continuer, le message de refus sinon.
 */
export function refuseUnknownUndo(
  trie: { match(input: string): { status: string } },
  args: readonly string[],
  rawLine?: string,
): string | null {
  const ligne = rawLine && rawLine.trim() ? rawLine.trim() : `undo ${args.join(' ')}`.trim();
  if (args.length === 0) return HUAWEI_ERRORS.INCOMPLETE(ligne);
  if (trie.match(args[0]).status !== 'invalid') return null;
  const pos = ligne.toLowerCase().indexOf(args[0].toLowerCase());
  return HUAWEI_ERRORS.UNRECOGNIZED(ligne, pos < 0 ? ligne.length : pos);
}

/**
 * Un mot que la grammaire d'une commande ne prevoit pas, refuse EN LE
 * DESIGNANT.
 *
 * Le plafond declare (`allowArgs`) traite les formes positionnelles
 * closes ; celle-ci traite les queues a mots-cles, ou compter les
 * arguments ne veut rien dire — `ip route-static … preference 100 tag 7
 * permanent` en porte six de plus que la forme minimale, tous
 * legitimes. Les boucles qui lisent ces queues n'avaient pas de branche
 * finale : un mot inconnu tombait dans le vide, sans effet et sans
 * message, et l'operateur croyait avoir configure ce qu'il avait tape.
 */
export function refuseMotInattenduVrp(ligne: string, token: string): string {
  const propre = ligne.trim();
  const pos = propre.toLowerCase().indexOf(token.toLowerCase());
  return HUAWEI_ERRORS.UNRECOGNIZED(propre, pos < 0 ? propre.length : pos);
}

/**
 * Ce qu'une grammaire de commande peut reprocher a une ligne. Le mot
 * fautif est porte par l'erreur plutot que devine au rendu : c'est ce
 * qui permet au curseur de designer `zzz` dans `stp mode zzz` au lieu de
 * `mode`, qui est le seul mot juste.
 *
 * `propre` sort du cadre des quatre familles positionnelles : c'est un
 * message specifique a la commande, sur une ligne et sans curseur, comme
 * `Error: OSPF is not configured.` — VRP en a, et leur en inventer une
 * position serait faux.
 */
export type ErreurGrammaireVrp =
  | { kind: 'incomplete' }
  | { kind: 'wrong'; token: string }
  | { kind: 'unrecognized'; token: string }
  | { kind: 'too-many'; token: string }
  | { kind: 'propre'; message: string };

/** Le rang du mot fautif dans la ligne, en comptant les mots. */
function positionDuMot(ligne: string, token: string): number {
  const mots = ligne.split(/\s+/);
  let curseur = 0;
  for (const mot of mots) {
    const at = ligne.indexOf(mot, curseur);
    if (mot.toLowerCase() === token.toLowerCase()) return at;
    curseur = at + mot.length;
  }
  const brut = ligne.toLowerCase().indexOf(token.toLowerCase());
  return brut < 0 ? ligne.length : brut;
}

export function rendreErreurVrp(err: ErreurGrammaireVrp, ligne: string): string {
  const propre = ligne.trim();
  switch (err.kind) {
    case 'incomplete': return HUAWEI_ERRORS.INCOMPLETE(propre);
    case 'propre': return err.message;
    case 'wrong': return HUAWEI_ERRORS.WRONG(propre, positionDuMot(propre, err.token));
    case 'unrecognized': return HUAWEI_ERRORS.UNRECOGNIZED(propre, positionDuMot(propre, err.token));
    case 'too-many': return HUAWEI_ERRORS.TOO_MANY(propre, positionDuMot(propre, err.token));
  }
}

// ─── Pipe Filter ───────────────────────────────────────────────────

export interface PipeFilter {
  type: string;
  pattern: string;
}

const PIPE_FILTER_RE = /^(include|exclude|begin|grep|findstr|section|count|redirect|append|tee)(?:\s+(.+))?$/i;

/**
 * Les trois modificateurs qui ÉCRIVENT au lieu de filtrer. Ils étaient
 * absents de l'expression ci-dessus, donc `parsePipeFilter` ne les
 * reconnaissait pas : la sortie partait au terminal sans qu'aucun
 * fichier soit créé, et `dir flash:` ne montrait rien de nouveau.
 *
 * `redirect` et `append` n'affichent RIEN — c'est ce qui les distingue
 * de `tee`, qui écrit et affiche.
 */
export const PIPE_WRITERS: ReadonlySet<string> = new Set(['redirect', 'append', 'tee']);

/** Ce que `| ?` propose sur IOS. */
export const PIPE_MODIFIERS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'append', description: 'Append redirected output to URL (URLs supporting append operation only)' },
  { keyword: 'begin', description: 'Begin with the line that matches' },
  { keyword: 'count', description: 'Count number of lines which match regexp' },
  { keyword: 'exclude', description: 'Exclude lines that match' },
  { keyword: 'include', description: 'Include lines that match' },
  { keyword: 'redirect', description: 'Redirect output to URL' },
  { keyword: 'section', description: 'Filter a section of output' },
  { keyword: 'tee', description: 'Copy output to URL' },
];

/**
 * Resolve a Huawei VRP global-navigation abbreviation.
 *
 * VRP accepts any unambiguous prefix. `quit`/`return` are the only
 * top-level navigation verbs, but `r`/`re` also prefix reset/reboot, so
 * `return` only matches from `ret` onward (avoids that ambiguity).
 * Shared by HuaweiSwitchShell and HuaweiVRPShell (DRY).
 */
export function resolveHuaweiNav(lower: string): 'return' | 'quit' | null {
  if (lower.length >= 1 && 'quit'.startsWith(lower)) return 'quit';
  if (lower.length >= 3 && 'return'.startsWith(lower)) return 'return';
  return null;
}

/**
 * Parse pipe filter from raw CLI input.
 * Returns the command portion and an optional pipe filter.
 *
 * Example: "show ip route | include 10.0" → { cmd: "show ip route", filter: { type: "include", pattern: "10.0" } }
 */
export function parsePipeFilter(trimmed: string): { cmd: string; filter: PipeFilter | null } {
  const pipeIdx = trimmed.indexOf(' | ');
  if (pipeIdx === -1) return { cmd: trimmed, filter: null };

  const cmd = trimmed.substring(0, pipeIdx).trim();
  const filterPart = trimmed.substring(pipeIdx + 3).trim();
  const match = filterPart.match(PIPE_FILTER_RE);
  if (!match) return { cmd, filter: null };

  return {
    cmd,
    filter: { type: match[1].toLowerCase(), pattern: match[2] ?? '' },
  };
}

/**
 * Apply a pipe filter (include/exclude/grep/findstr) to CLI output.
 * Strips surrounding quotes from pattern before matching (Cisco behavior).
 */
export function applyPipeFilter(output: string, filter: PipeFilter | null): string {
  if (!filter || !output) return output;

  const lines = output.split('\n');
  let pattern = filter.pattern;

  // Strip surrounding quotes (consistent Cisco behavior)
  if ((pattern.startsWith('"') && pattern.endsWith('"')) ||
      (pattern.startsWith("'") && pattern.endsWith("'"))) {
    pattern = pattern.slice(1, -1);
  }

  // IOS pipe patterns are regular expressions (`| include ^!` anchors on
  // line start, `include foo|bar` alternates); an invalid regex degrades
  // to a literal substring match.
  const matcher = buildPipeMatcher(pattern);

  if (filter.type === 'include' || filter.type === 'grep' || filter.type === 'findstr') {
    return lines.filter(matcher).join('\n');
  }
  if (filter.type === 'exclude') {
    return lines.filter(l => !matcher(l)).join('\n');
  }
  if (filter.type === 'begin') {
    const start = lines.findIndex(matcher);
    return start === -1 ? '' : lines.slice(start).join('\n');
  }
  if (filter.type === 'section') {
    return extractSections(lines, pattern).join('\n');
  }
  // L'écriture appartient au shell, qui seul tient le système de
  // fichiers ; ici on ne décide que de ce qui reste à l'écran.
  if (PIPE_WRITERS.has(filter.type)) {
    return filter.type === 'tee' ? output : '';
  }
  if (filter.type === 'count') {
    if (!pattern) return String(lines.length);
    try {
      const re = new RegExp(pattern);
      let count = 0;
      for (const l of lines) if (re.test(l)) count++;
      return String(count);
    } catch {
      let count = 0;
      for (const l of lines) if (l.includes(pattern)) count++;
      return String(count);
    }
  }

  return output;
}

function buildPipeMatcher(pattern: string): (line: string) => boolean {
  try {
    const re = new RegExp(pattern);
    return (line) => re.test(line);
  } catch {
    return (line) => line.includes(pattern);
  }
}

function extractSections(lines: string[], pattern: string): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isTopLevel = line.length > 0 && !/^\s/.test(line);
    if (isTopLevel && re.test(line)) {
      out.push(line);
      i++;
      if (/^banner \S+ \^C$/.test(line)) {
        // A multi-line banner block runs to its closing ^C, not by
        // indentation — its content sits in column 0.
        while (i < lines.length) {
          out.push(lines[i]);
          const closed = lines[i] === '^C';
          i++;
          if (closed) break;
        }
      } else {
        while (i < lines.length && (/^\s/.test(lines[i]) || lines[i] === '')) {
          out.push(lines[i]);
          i++;
        }
      }
      // IOS includes the block-terminating ! in | section output.
      if (i < lines.length && lines[i].trim() === '!') {
        out.push(lines[i]);
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

// ─── Interface Name Resolution ────────────────────────────────────

/** Cisco interface abbreviation → full prefix */
const CISCO_INTERFACE_PREFIXES: Record<string, string> = {
  'g': 'GigabitEthernet',
  'gi': 'GigabitEthernet',
  'gig': 'GigabitEthernet',
  'giga': 'GigabitEthernet',
  'gigabit': 'GigabitEthernet',
  'gigabitethernet': 'GigabitEthernet',
  'fa': 'FastEthernet',
  'fast': 'FastEthernet',
  'fastethernet': 'FastEthernet',
  'se': 'Serial',
  'serial': 'Serial',
  'lo': 'Loopback',
  'loopback': 'Loopback',
  'tu': 'Tunnel',
  'tunnel': 'Tunnel',
  'ge': 'GE',
};

/**
 * Les types d'interface de VRP. L'abreviation n'est PAS une liste
 * d'ecritures admises mais une regle : tout prefixe non ambigu du nom du
 * type. Une table fermee ne peut jamais l'exprimer — elle acceptait
 * `ge0/0/0` et `gi0/0/0` mais refusait `g0/0/0`, `loop0` et `l0`, qui
 * sont pourtant les frappes les plus courantes.
 */
export const HUAWEI_INTERFACE_TYPES: readonly string[] = [
  'GigabitEthernet', 'Ethernet', 'Eth-Trunk', 'LoopBack',
  'NULL', 'Nve', 'Tunnel', 'Vlanif', 'MEth',
];

/**
 * Les noms courts INTERNES, qui ne sont pas des abreviations de VRP mais
 * la facon dont ce simulateur range ses ports. Ils restent acceptes a la
 * saisie parce qu'ils l'etaient deja.
 */
const HUAWEI_INTERNAL_SHORT: Record<string, string> = { 'ge': 'GigabitEthernet' };

/**
 * Le type d'interface qu'un prefixe designe, ou `null` quand il n'en
 * designe aucun ou plusieurs. Meme regle pour resoudre un port existant
 * et pour en creer un : trois tables de types coexistaient, et elles ne
 * disaient pas la meme chose.
 */
export function huaweiTypeInterface(prefixe: string): string | null {
  const t = huaweiTypesPourPrefixe(prefixe);
  return t.length === 1 ? t[0] : null;
}

/** Les types qu'un prefixe designe. Plus d'un : la saisie est ambigue. */
function huaweiTypesPourPrefixe(prefixe: string): string[] {
  const p = prefixe.toLowerCase();
  const interne = HUAWEI_INTERNAL_SHORT[p];
  if (interne) return [interne];
  return HUAWEI_INTERFACE_TYPES.filter((t) => t.toLowerCase().startsWith(p));
}

const IFACE_NAME_RE = /^([a-z]+)([\d/.-]+)$/;

/**
 * Resolve abbreviated Cisco interface name to the actual port name.
 * E.g. "gi0/0" → "GigabitEthernet0/0"
 */
export function resolveCiscoInterfaceName(
  portNames: Iterable<string>,
  input: string,
): string | null {
  const combined = input.replace(/\s+/g, '');
  const lower = combined.toLowerCase();

  // Direct match
  for (const name of portNames) {
    if (name.toLowerCase() === lower || name === input.trim()) return name;
  }

  // Abbreviation expansion
  const match = lower.match(IFACE_NAME_RE);
  if (!match) return null;

  const [, prefix, numbers] = match;
  const fullPrefix = CISCO_INTERFACE_PREFIXES[prefix];
  if (!fullPrefix) return null;

  const resolved = `${fullPrefix}${numbers}`;
  for (const name of portNames) {
    if (name === resolved) return name;
  }

  return null;
}

/**
 * Resolve abbreviated Huawei interface name to the actual port name.
 * E.g. "ge0/0/0" → "GE0/0/0"
 */
export function resolveHuaweiInterfaceName(
  portNames: Iterable<string>,
  input: string,
): string | null {
  // VRP admet que le numero soit separe du type (`GigabitEthernet 0/0/0`,
  // `LoopBack 0`) : c'est une forme, pas une abreviation. Le switch la
  // collapsait deja dans SA copie du resolveur, le routeur non — d'ou
  // deux plateformes qui n'acceptaient pas les memes ecritures.
  const lower = input.replace(/\s+/g, '').toLowerCase();

  for (const name of portNames) {
    if (name.toLowerCase() === lower) return name;
  }

  const match = lower.match(/^([a-z-]+)([\d/.]+)$/);
  if (!match) return null;

  const numbers = match[2];
  const types = huaweiTypesPourPrefixe(match[1]);
  // Zero type : la saisie ne designe rien. Plusieurs : elle est ambigue,
  // et deviner serait pire que refuser.
  if (types.length !== 1) return null;

  // Le port peut etre range sous son nom complet ou sous le nom court
  // interne (`GE0/0/0`) : on essaie les deux.
  const formes = types[0] === 'GigabitEthernet' ? ['GE', 'GigabitEthernet'] : types;
  for (const prefix of formes) {
    const resolved = `${prefix}${numbers}`;
    for (const name of portNames) {
      if (name === resolved) return name;
    }
  }
  return null;
}
