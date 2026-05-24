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
}

export interface PsShimState {
  vars: Map<string, string>;
  fns: Map<string, string>;
  aliases: Map<string, string>;
}

export function createShimState(): PsShimState {
  return { vars: new Map(), fns: new Map(), aliases: new Map() };
}

type State = PsShimState;

const PS_SWITCH_FLAGS = new Set([
  '-nologo', '-noprofile', '-noninteractive', '-noexit', '-sta', '-mta',
]);
const PS_VALUE_FLAGS = new Set([
  '-executionpolicy', '-version', '-windowstyle', '-inputformat',
  '-outputformat', '-encodedcommand', '-configurationname', '-file',
  '-psconsolefile',
]);

function extractPsScript(args: string[]): string {
  const cIdx = args.findIndex(a => /^-c(ommand)?$/i.test(a));
  if (cIdx !== -1) return args.slice(cIdx + 1).join(' ');
  let i = 0;
  while (i < args.length) {
    const a = args[i].toLowerCase();
    if (PS_SWITCH_FLAGS.has(a)) { i++; continue; }
    if (PS_VALUE_FLAGS.has(a)) { i += 2; continue; }
    if (a === '-' || a === '--') { i++; break; }
    break;
  }
  return args.slice(i).join(' ');
}

export async function runPowerShellShim(
  ctx: PsCmdShimContext,
  args: string[],
): Promise<string> {
  const raw = extractPsScript(args).trim();
  if (!raw) return '';
  const script = stripBalancedQuotes(raw);
  const state: State = ctx.shimState ?? createShimState();
  return evalScript(state, script, ctx);
}

function stripBalancedQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
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
    const value = await evalExpression(state, assign[2].trim(), ctx);
    state.vars.set(assign[1], value);
    return '';
  }

  // bare $x → print
  const bareVar = /^\$([A-Za-z_]\w*)\s*$/.exec(stmt);
  if (bareVar) return state.vars.get(bareVar[1]) ?? '';

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

  // Fall through to cmd.exe (covers ssh, hostname, etc.).
  return (await ctx.executeCmdCommand(stmt)).trim();
}

async function evalExpression(state: State, expr: string, ctx: PsCmdShimContext): Promise<string> {
  // Variable
  const ref = /^\$([A-Za-z_]\w*)\s*$/.exec(expr);
  if (ref) return state.vars.get(ref[1]) ?? '';

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
