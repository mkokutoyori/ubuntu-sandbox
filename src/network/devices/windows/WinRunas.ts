/**
 * `runas` — extracted from `WindowsPC.cmdRunas` (PRD-Nslookup-Dig-Rndc-Runas.md
 * §1.3 gap #13/§2.1.6/P11).
 *
 * Two entry points, matching the two ways `runas` reaches a device in this
 * simulator:
 *  - `parseAndValidate` + `execute`: the plain, non-interactive
 *    `device.executeCommand('runas /user:X program')` path (existing tests
 *    drive this directly, with no password — kept exactly as before, since
 *    there is no terminal to prompt through at that layer).
 *  - `execute` alone, called by `WindowsTerminalSession` *after* it has
 *    interactively collected and verified the password via the same
 *    `ITerminalIO`/`inputMode` masked-prompt mechanism already established
 *    for SSH's top-level password challenge (see
 *    `WindowsTerminalSession.tryStartRunasInteractive`/`submitRunasPassword`).
 */

export interface RunasUserLookup {
  readonly name: string;
  readonly enabled: boolean;
}

/** What `validateRunasUser` needs — deliberately narrower than {@link RunasHost} so a caller that only validates (e.g. before prompting for a password) doesn't have to fake the rest. */
export interface RunasUserSource {
  getUser(name: string): RunasUserLookup | undefined;
}

export interface RunasHost extends RunasUserSource {
  getCurrentUser(): string;
  setCurrentUser(name: string): void;
  executeCmdCommand(command: string): Promise<string>;
}

export interface RunasInvocation {
  readonly userName: string;
  readonly command: string;
  /** `/netonly`: the target account is used only for outbound network auth, never verified locally or switched into — PRD §2.2's accepted simplification collapses this to "run as the caller". */
  readonly netOnly: boolean;
  /** `/savecred`: store the password in a small per-user vault after the first successful prompt, and skip the prompt on subsequent invocations. */
  readonly saveCred: boolean;
}

export type RunasParseResult =
  | { readonly ok: true; readonly invocation: RunasInvocation }
  | { readonly ok: false; readonly error: string };

const USAGE = 'RUNAS USAGE:\n\nRUNAS [/netonly] [/savecred] /user:<UserName> program';

export function parseRunasArgs(args: string[]): RunasParseResult {
  if (args.length === 0) return { ok: false, error: USAGE };

  let userName = '';
  let netOnly = false;
  let saveCred = false;
  const cmdParts: string[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower.startsWith('/user:')) userName = arg.slice(6);
    else if (lower === '/netonly') netOnly = true;
    else if (lower === '/savecred') saveCred = true;
    else cmdParts.push(arg);
  }

  if (!userName) return { ok: false, error: USAGE };
  if (cmdParts.length === 0) return { ok: false, error: 'RUNAS ERROR: No command specified.' };

  return { ok: true, invocation: { userName, command: cmdParts.join(' '), netOnly, saveCred } };
}

export type RunasValidation = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function validateRunasUser(host: RunasUserSource, userName: string): RunasValidation {
  const user = host.getUser(userName);
  if (!user) return { ok: false, error: `RUNAS ERROR: The user name "${userName}" is not recognized.` };
  if (!user.enabled) return { ok: false, error: `RUNAS ERROR: The account "${userName}" is disabled.` };
  return { ok: true };
}

/**
 * Runs `command` under `userName`'s identity, restoring the caller's
 * identity afterwards — real `runas` launches the program in a separate
 * logon session; the calling shell keeps its own identity once it returns.
 */
export async function runAsUser(host: RunasHost, userName: string, command: string): Promise<string> {
  const previousUser = host.getCurrentUser();
  host.setCurrentUser(userName);
  try {
    return await host.executeCmdCommand(command);
  } finally {
    host.setCurrentUser(previousUser);
  }
}

/** The plain, non-interactive `runas` path (no password check — see file header). */
export async function runRunasNonInteractive(host: RunasHost, args: string[]): Promise<string> {
  const parsed = parseRunasArgs(args);
  if (parsed.ok === false) return parsed.error;
  const { userName, command, netOnly } = parsed.invocation;
  if (netOnly) return runAsUser(host, host.getCurrentUser(), command);
  const validation = validateRunasUser(host, userName);
  if (validation.ok === false) return validation.error;
  return runAsUser(host, userName, command);
}

/** Real runas.exe's wrong-password message — a single attempt, no retry (unlike SSH). */
export function runasIncorrectPasswordMessage(command: string): string {
  return `RUNAS ERROR: Unable to run - ${command}.\n1326: The user name or password is incorrect.`;
}
