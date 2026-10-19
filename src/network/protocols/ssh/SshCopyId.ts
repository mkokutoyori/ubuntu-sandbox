export interface SshCopyIdOutcome {
  readonly output: string;
  readonly exitCode: number;
}

export interface SshCopyIdSsh {
  (args: readonly string[], stdin?: string): Promise<SshCopyIdOutcome>;
}

export interface SshCopyIdSftp {
  (args: readonly string[], keys: string): Promise<SshCopyIdOutcome>;
}

export interface SshCopyIdEnvironment {
  readonly home: string;
  readonly readable: (path: string) => string | null;
  readonly newestPublicKey: () => string | null;
  readonly agentKeys: () => Promise<string[]>;
  readonly ssh: SshCopyIdSsh;
  readonly sftp: SshCopyIdSftp;
}

const PROGRAM = '/usr/bin/ssh-copy-id';

const USAGE = `Usage: ${PROGRAM} [-h|-?|-f|-n|-s] [-i [identity_file]] [-p port] [-F alternative ssh_config file] [[-o <ssh -o options>] ...] [user@]hostname`;

const INSTALLER =
  "exec sh -c 'cd; umask 077; mkdir -p .ssh && { [ -z `tail -1c .ssh/authorized_keys 2>/dev/null` ] || echo >> .ssh/authorized_keys || exit 1; } && cat >> .ssh/authorized_keys || exit 1; if type restorecon >/dev/null 2>&1; then restorecon -F .ssh .ssh/authorized_keys; fi'";

function quote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

interface Parsed {
  readonly sshOptions: readonly string[];
  readonly loginHint: readonly string[];
  readonly identity: string | null;
  readonly identityGiven: boolean;
  readonly forced: boolean;
  readonly dryRun: boolean;
  readonly useSftp: boolean;
  readonly target: readonly string[];
}

type Parse = { readonly kind: 'ok'; readonly value: Parsed } | { readonly kind: 'usage'; readonly lead: string };

function parse(args: readonly string[]): Parse {
  const sshOptions: string[] = [];
  const loginHint: string[] = [];
  let identity: string | null = null;
  let identityGiven = false;
  let forced = false;
  let dryRun = false;
  let useSftp = false;
  const rest = [...args];
  while (rest.length > 0) {
    const word = rest[0];
    if (identityGiven && /^-i/.test(word)) {
      return { kind: 'usage', lead: `\n${PROGRAM}: ERROR: -i option must not be specified more than once\n` };
    }
    let option = '';
    let optionArgument = '';
    if (/^-[ioFpt].+/.test(word)) {
      option = word.slice(0, 2);
      optionArgument = word.slice(2);
      rest.shift();
    } else if (/^-[ioFpt]$/.test(word)) {
      option = word;
      optionArgument = rest[1] ?? '';
      rest.splice(0, 2);
    } else if (/^-[1246afhns?]$/.test(word)) {
      option = word;
      rest.shift();
    } else if (word === '--') {
      rest.shift();
      break;
    } else if (word.startsWith('-') && word.length > 1) {
      return { kind: 'usage', lead: `\n${PROGRAM}: ERROR: invalid option (${word})` };
    } else {
      break;
    }
    switch (option) {
      case '-i': identityGiven = true; identity = optionArgument === '' ? null : optionArgument; break;
      case '-o': case '-p': case '-F': case '-t': {
        sshOptions.push(option, quote(optionArgument));
        loginHint.push(option, quote(optionArgument));
        break;
      }
      case '-1': case '-2': case '-4': case '-6': case '-a': sshOptions.push(option); loginHint.push(option); break;
      case '-f': forced = true; break;
      case '-n': dryRun = true; break;
      case '-s': useSftp = true; break;
      case '-h': case '-?': return { kind: 'usage', lead: '' };
      default: break;
    }
  }
  return {
    kind: 'ok',
    value: { sshOptions, loginHint, identity, identityGiven, forced, dryRun, useSftp, target: rest },
  };
}

function usageOutcome(lead: string): SshCopyIdOutcome {
  return { output: `${lead === '' ? '' : `${lead}\n`}${USAGE}`, exitCode: 1 };
}

interface KeySource {
  readonly keys: string[];
  readonly description: string;
  readonly privatePath: string | null;
}

export async function runSshCopyId(args: readonly string[], env: SshCopyIdEnvironment): Promise<SshCopyIdOutcome> {
  const parsed = parse(args);
  if (parsed.kind === 'usage') return usageOutcome(parsed.lead);
  const options = parsed.value;
  if (options.target.length === 0) return usageOutcome('');

  const lines: string[] = [];
  const fail = (code = 1): SshCopyIdOutcome => ({ output: lines.join('\n'), exitCode: code });

  let source: KeySource | null = null;
  const useIdFile = (given: string): string | null => {
    const publicPath = given.endsWith('.pub') ? given : `${given}.pub`;
    const privatePath = publicPath.slice(0, -'.pub'.length);
    const publicText = env.readable(publicPath);
    if (publicText === null) {
      lines.push(`\n${PROGRAM}: ERROR: failed to open ID file '${publicPath}': No such file or directory\n`);
      return null;
    }
    if (!options.forced && env.readable(privatePath) === null) {
      lines.push(`\n${PROGRAM}: ERROR: failed to open ID file '${privatePath}': No such file or directory\n\t(to install the contents of '${publicPath}' anyway, look at the -f option)\n`);
      return null;
    }
    source = {
      keys: publicText.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      description: `"${publicPath}"`,
      privatePath: env.readable(privatePath) === null ? null : privatePath,
    };
    return publicPath;
  };

  if (options.identityGiven) {
    const given = options.identity ?? env.newestPublicKey();
    if (given === null) {
      lines.push(`${PROGRAM}: ERROR: no ID file found`);
      return fail();
    }
    if (useIdFile(given) === null) return fail();
  } else {
    const agent = await env.agentKeys();
    if (agent.length > 0) {
      source = { keys: agent, description: '(ssh-add -L)', privatePath: null };
    } else {
      const fallback = env.newestPublicKey();
      if (fallback !== null && useIdFile(fallback) === null) return fail();
    }
  }
  const chosen = source as KeySource | null;
  if (chosen === null || chosen.keys.length === 0) {
    lines.push(`${PROGRAM}: ERROR: No identities found`);
    return fail();
  }
  lines.push(`${PROGRAM}: INFO: Source of key(s) to be installed: ${chosen.description}`);

  let pending = chosen.keys;
  if (!options.forced) {
    lines.push(`${PROGRAM}: INFO: attempting to log in with the new key(s), to filter out any that are already installed`);
    const missing: string[] = [];
    for (const key of chosen.keys) {
      const identityArgs = chosen.privatePath === null ? [] : ['-i', chosen.privatePath];
      const probe = await env.ssh([
        '-a', '-x', ...identityArgs, '-o', 'PreferredAuthentications=publickey', '-o', 'IdentitiesOnly=yes',
        ...unquote(options.sshOptions), ...options.target, 'exit',
      ]);
      const failure = /(connect to host|Could not resolve hostname)/.exec(probe.output);
      if (failure !== null) {
        const detail = probe.output.split('\n').find((line) => /(connect to host|Could not resolve hostname)/.test(line)) ?? probe.output;
        lines.push(`\n${PROGRAM}: ERROR: ${detail.trim()}\n`);
        return fail();
      }
      if (probe.exitCode !== 0) missing.push(key);
    }
    pending = missing;
    if (pending.length === 0) {
      lines.push(`\n${PROGRAM}: WARNING: All keys were skipped because they already exist on the remote system.\n\t\t(if you think this is a mistake, you may want to use -f option)\n`);
      return { output: lines.join('\n'), exitCode: 0 };
    }
    lines.push(`${PROGRAM}: INFO: ${pending.length} key(s) remain to be installed -- if you are prompted now it is to install the new keys`);
  }

  if (options.dryRun) {
    lines.push('=-=-=-=-=-=-=-=', 'Would have added the following key(s):', '', ...pending, '=-=-=-=-=-=-=-=');
    return { output: lines.join('\n'), exitCode: 0 };
  }

  const keysText = `${pending.join('\n')}\n`;
  const installed = options.useSftp
    ? await env.sftp([...unquote(options.sshOptions), ...options.target], keysText)
    : await env.ssh(['-a', '-x', ...unquote(options.sshOptions), ...options.target, INSTALLER], keysText);
  if (installed.output !== '') lines.push(installed.output.replace(/\n$/, ''));
  if (installed.exitCode !== 0) return fail();
  lines.push(
    '',
    `Number of key(s) added: ${pending.length}`,
    '',
    `Now try logging into the machine, with:   "${options.useSftp ? 'sftp' : 'ssh'}${options.loginHint.length > 0 ? ` ${options.loginHint.join(' ')}` : ''} ${options.target.map(quote).join(' ')}"`,
    'and check to make sure that only the key(s) you wanted were added.',
    '',
  );
  return { output: lines.join('\n'), exitCode: 0 };
}

function unquote(words: readonly string[]): string[] {
  return words.map((word) => (word.startsWith("'") && word.endsWith("'") ? word.slice(1, -1).replace(/'\\''/g, "'") : word));
}
