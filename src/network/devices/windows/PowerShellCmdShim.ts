/**
 * PowerShellCmdShim — minimal PowerShell `-Command "<script>"` evaluator
 * invoked when an operator types `powershell -Command ...` at cmd.exe.
 *
 * This is NOT a full PSRuntime — it covers the slice of grammar the
 * cross-equipment SSH suite exercises:
 *   - statement separator `;`
 *   - variable assignment `$x = <expression>`
 *   - bare variable reference `$x`  → print
 *   - `function NAME { BODY }`      → store
 *   - `Set-Alias name target`       → store alias
 *   - invocation of a stored function or alias
 *   - `command | Select-String <pattern>` pipeline
 *   - any other word → delegate to cmd.exe via executeCmdCommand
 *
 * Anything more exotic falls through to the standard PowerShell
 * subshell (PSInterpreter) when it's wired; the shim is the cmd.exe
 * compatibility shortcut.
 */

export interface PsCmdShimContext {
  /** Run a command line via cmd.exe — used for ssh, hostname, …  */
  executeCmdCommand(line: string): Promise<string>;
  /** Persistent shim state across `powershell -Command` invocations. */
  shimState?: PsShimState;
  /**
   * When present, cmdlet-shaped tokens (Verb-Noun) unknown to the shim
   * are routed to the full PowerShell runtime instead of falling back
   * to cmd.exe. Callers should reuse the same interpreter across shim
   * invocations so `$vars`, aliases and functions defined in previous
   * -Command lines persist.
   */
  runFullPs?(code: string): string | Promise<string>;
}

export interface PsShimState {
  vars: Map<string, string>;
  fns: Map<string, string>;
  aliases: Map<string, string>;
  /**
   * Noms dont la valeur vit dans le vrai moteur et non dans `vars`.
   * `vars` ne sait retenir que du texte : une affectation d'objet
   * (`$a = New-ScheduledTaskAction …`) y perdait l'objet et ne rendait
   * que son tableau imprimé, si bien que le `-Action $a` de la phrase
   * suivante arrivait vide au cmdlet.
   */
  runtimeVars: Set<string>;
}

export function createShimState(): PsShimState {
  return { vars: new Map(), fns: new Map(), aliases: new Map(), runtimeVars: new Set() };
}

type State = PsShimState;

const PS_SWITCH_FLAGS = new Set([
  '-nologo', '-noprofile', '-noninteractive', '-noexit', '-sta', '-mta',
]);
const PS_VALUE_FLAGS = new Set([
  '-executionpolicy', '-version', '-windowstyle', '-inputformat',
  '-outputformat', '-encodedcommand', '-configurationname',
  '-psconsolefile',
]);

/**
 * `-File <path> [args…]`. It used to sit in PS_VALUE_FLAGS, which meant
 * the path was recognised and then thrown away: `powershell -File x.ps1`
 * printed nothing at all, and adding a script parameter made the whole
 * line fall through to cmd.exe and come back as "powershell is not
 * recognized". Everything after the path belongs to the script, exactly
 * as the real host passes it.
 */
function extractFileInvocation(args: string[]): { path: string; scriptArgs: string[] } | null {
  const idx = args.findIndex(a => /^-f(ile)?$/i.test(a));
  if (idx === -1 || !args[idx + 1]) return null;
  return { path: args[idx + 1], scriptArgs: args.slice(idx + 2) };
}

function quoteForPs(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

function psScriptStart(args: string[]): number {
  const cIdx = args.findIndex(a => /^-c(ommand)?$/i.test(a));
  if (cIdx !== -1) return cIdx + 1;
  let i = 0;
  while (i < args.length) {
    const a = args[i].toLowerCase();
    if (PS_SWITCH_FLAGS.has(a)) { i++; continue; }
    if (PS_VALUE_FLAGS.has(a)) { i += 2; continue; }
    if (a === '-' || a === '--') { i++; break; }
    break;
  }
  return i;
}

export async function runPowerShellShim(
  ctx: PsCmdShimContext,
  args: string[],
  rawArgs?: string[],
): Promise<string> {
  const file = extractFileInvocation(args);
  if (file) {
    if (!ctx.runFullPs) {
      return `powershell : Cannot run "${file.path}" — no PowerShell engine is available on this host.`;
    }
    const call = [`& ${quoteForPs(file.path)}`, ...file.scriptArgs].join(' ');
    return String(await ctx.runFullPs(call)).replace(/\s+$/, '');
  }

  const source = rawArgs && rawArgs.length === args.length ? rawArgs : args;
  const raw = source.slice(psScriptStart(args)).join(' ').trim();
  if (!raw) return '';
  const script = stripBalancedQuotes(raw);
  const state: State = ctx.shimState ?? createShimState();
  return evalScript(state, script, ctx);
}

function stripBalancedQuotes(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1);
  }
  return s;
}

async function evalScript(state: State, script: string, ctx: PsCmdShimContext): Promise<string> {
  const lines: string[] = [];
  for (const raw of splitStatements(script)) {
    const stmt = raw.trim();
    if (!stmt) continue;
    const out = await evalStatement(state, stmt, ctx);
    if (out) lines.push(out);
  }
  return lines.join('\n');
}

/** Split on top-level `;`, respecting `{...}` blocks and quoted strings. */
function splitStatements(script: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote) {
      if (c === quote) quote = null;
      buf += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '{') { depth++; buf += c; continue; }
    if (c === '}') { depth--; buf += c; continue; }
    if (c === ';' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

async function evalStatement(state: State, stmt: string, ctx: PsCmdShimContext): Promise<string> {
  // function NAME { BODY }
  const fn = /^function\s+([A-Za-z_][\w-]*)\s*\{([\s\S]*)\}\s*$/.exec(stmt);
  if (fn) { state.fns.set(fn[1].toLowerCase(), fn[2].trim()); return ''; }

  // Set-Alias name target
  const sa = /^Set-Alias\s+(\S+)\s+(\S+)\s*$/i.exec(stmt);
  if (sa) { state.aliases.set(sa[1].toLowerCase(), sa[2]); return ''; }

  // $x = <expression>
  const assign = /^\$([A-Za-z_]\w*)\s*=\s*(.+)$/s.exec(stmt);
  if (assign) {
    const name = assign[1];
    const rhs = assign[2].trim();
    if (ctx.runFullPs && looksLikeCmdlet(headWordOf(rhs))) {
      await ctx.runFullPs(withShimVars(state, stmt));
      runtimeVars(state).add(name);
      state.vars.delete(name);
      return '';
    }
    const value = await evalExpression(state, rhs, ctx);
    state.vars.set(name, value);
    runtimeVars(state).delete(name);
    return '';
  }

  // bare $x → print
  const bareVar = /^\$([A-Za-z_]\w*)\s*$/.exec(stmt);
  if (bareVar) {
    if (ctx.runFullPs && runtimeVars(state).has(bareVar[1]))
      return String(await ctx.runFullPs(stmt)).replace(/\s+$/, '');
    return state.vars.get(bareVar[1]) ?? '';
  }

  // Pipeline with Select-String
  const pipeIdx = stmt.indexOf('|');
  if (pipeIdx !== -1) {
    const head = stmt.slice(0, pipeIdx).trim();
    const tail = stmt.slice(pipeIdx + 1).trim();
    const headOut = await evalStatement(state, head, ctx);
    return applyPipeFilter(headOut, tail);
  }

  // Function or alias invocation
  const headWord = stmt.split(/\s+/)[0];
  const fnBody = state.fns.get(headWord.toLowerCase());
  if (fnBody) return evalScript(state, fnBody, ctx);
  const target = state.aliases.get(headWord.toLowerCase());
  if (target) {
    // Replace head word with the alias target and re-evaluate.
    const rest = stmt.slice(headWord.length).trim();
    return evalStatement(state, `${target}${rest ? ' ' + rest : ''}`, ctx);
  }

  if (ctx.runFullPs && looksLikeCmdlet(headWord)) {
    return String(await ctx.runFullPs(withShimVars(state, stmt))).replace(/\s+$/, '');
  }

  // Fall through to cmd.exe (covers ssh, hostname, etc.).
  return (await ctx.executeCmdCommand(stmt)).trim();
}

function looksLikeCmdlet(word: string): boolean {
  return /^[A-Za-z]+-[A-Za-z][\w-]*$/.test(word);
}

/** Premier mot d'une expression, parenthèse et `&` d'invocation retirés. */
function headWordOf(expr: string): string {
  return expr.replace(/^[&(\s]+/, '').split(/[\s(]/)[0] ?? '';
}

function runtimeVars(state: State): Set<string> {
  if (!state.runtimeVars) state.runtimeVars = new Set();
  return state.runtimeVars;
}

/**
 * Le shim et le moteur tiennent chacun leurs variables. Une phrase confiée
 * au moteur ne verrait donc pas celles que le shim a retenues — `$h = hostname`
 * puis `Write-Output $h` rendait une ligne vide. Les noms cités par la phrase,
 * et eux seuls, sont réinjectés ; un nom que le moteur possède déjà n'est
 * jamais écrasé par la copie texte du shim.
 */
function withShimVars(state: State, code: string): string {
  const owned = runtimeVars(state);
  const seeds: string[] = [];
  for (const [name, value] of state.vars) {
    if (owned.has(name)) continue;
    if (!new RegExp(`\\$${name}\\b`).test(code)) continue;
    seeds.push(`$${name} = '${String(value).replace(/'/g, "''")}'`);
  }
  return seeds.length > 0 ? `${seeds.join('\n')}\n${code}` : code;
}

async function evalExpression(state: State, expr: string, ctx: PsCmdShimContext): Promise<string> {
  // Variable
  const ref = /^\$([A-Za-z_]\w*)\s*$/.exec(expr);
  if (ref) {
    if (ctx.runFullPs && runtimeVars(state).has(ref[1]))
      return String(await ctx.runFullPs(expr)).replace(/\s+$/, '');
    return state.vars.get(ref[1]) ?? '';
  }

  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(expr)) return expr;

  // String literal
  const str = /^"([^"]*)"$/.exec(expr) ?? /^'([^']*)'$/.exec(expr);
  if (str) return str[1];

  // Pipeline as expression
  if (expr.includes('|')) {
    const out = await evalStatement(state, expr, ctx);
    return out;
  }

  // Function or alias
  const head = expr.split(/\s+/)[0];
  const fnBody = state.fns.get(head.toLowerCase());
  if (fnBody) return evalScript(state, fnBody, ctx);
  const target = state.aliases.get(head.toLowerCase());
  if (target) {
    const rest = expr.slice(head.length).trim();
    return evalExpression(state, `${target}${rest ? ' ' + rest : ''}`, ctx);
  }

  if (ctx.runFullPs && looksLikeCmdlet(headWordOf(expr))) {
    return String(await ctx.runFullPs(withShimVars(state, expr))).replace(/\s+$/, '');
  }

  // External command via cmd.exe
  return (await ctx.executeCmdCommand(expr)).trim();
}

/** Implement `Select-String <pattern>` on the head's output. */
function applyPipeFilter(output: string, tail: string): string {
  const ss = /^Select-String\s+(\S+)\s*$/i.exec(tail);
  if (ss) {
    const pat = new RegExp(ss[1].replace(/^"|"$/g, ''), 'i');
    return output.split('\n').filter(l => pat.test(l)).join('\n');
  }
  return output;
}
