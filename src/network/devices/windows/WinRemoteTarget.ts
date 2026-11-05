export interface RemoteTarget {
  readonly host: string;
  readonly credential?: { readonly username: string; readonly password: string };
  readonly rest: readonly string[];
}

export const REMOTE_CAPABLE_COMMANDS: ReadonlySet<string> = new Set(['tasklist', 'taskkill', 'getmac', 'systeminfo', 'schtasks']);

export function extractRemoteTarget(args: readonly string[]): RemoteTarget | null {
  let host: string | null = null;
  let username: string | null = null;
  let password: string | null = null;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    const flag = word.toLowerCase();
    if (flag === '/s' && index + 1 < args.length) { host = args[++index].replace(/^\\\\/, ''); continue; }
    if (flag === '/u' && index + 1 < args.length) { username = args[++index]; continue; }
    if (flag === '/p' && index + 1 < args.length && host !== null && username !== null) { password = args[++index]; continue; }
    rest.push(word);
  }
  if (host === null) return null;
  const credential = username !== null && password !== null ? { username, password } : undefined;
  return { host, credential, rest };
}
