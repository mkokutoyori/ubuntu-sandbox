/**
 * useraddOptions — a single, shared parser for `useradd` invocations.
 *
 * `useradd` is the low-level (non-interactive) account command. Its argument
 * surface is wide — UID override, system accounts, pre-hashed passwords,
 * account aging — and was previously parsed incompletely. This module is the
 * one authority: the command handler (`LinuxUserCommands.cmdUseradd`) and the
 * executor's home-skeleton logic both feed it the same token list and read
 * back the same structured `UseraddRequest`.
 *
 * Long (`--create-home`) and short (`-m`) option spellings are both accepted,
 * mirroring the real util-linux `useradd`.
 */

// ─── Parsed request ─────────────────────────────────────────────────────

export interface UseraddRequest {
  /** The login name (last non-option token). Empty when omitted. */
  username: string;
  /** `-u, --uid` */
  uid?: number;
  /** `-g, --gid` — primary group, by name or numeric id. */
  primaryGroup?: string;
  /** `-G, --groups` — supplementary groups. */
  supplementaryGroups: string[];
  /** `-d, --home-dir` */
  home?: string;
  /** `-b, --base-dir` */
  baseDir?: string;
  /** `-s, --shell` */
  shell?: string;
  /** `-c, --comment` — the raw GECOS string. */
  comment?: string;
  /** `-p, --password` — pre-hashed password. */
  passwordHash?: string;
  /** `-e, --expiredate` */
  expireDate?: string;
  /** `-f, --inactive` */
  inactiveDays?: number;
  /** `-k, --skel` */
  skeletonDir?: string;
  /** `-m, --create-home` */
  createHome: boolean;
  /** `-M, --no-create-home` */
  noCreateHome: boolean;
  /** `-r, --system` */
  systemAccount: boolean;
  /** `-o, --non-unique` */
  nonUnique: boolean;
  /** `-N, --no-user-group` */
  noUserGroup: boolean;
  /** `-U, --user-group` */
  userGroup: boolean;
  /** Tokens that were not recognised — surfaced for diagnostics. */
  unknownOptions: string[];
}

// ─── Option spec ────────────────────────────────────────────────────────

/** Short/long option spellings that consume the following token as a value. */
const VALUE_OPTIONS: Record<string, keyof UseraddRequest | 'expiredate' | 'inactive'> = {
  '-u': 'uid', '--uid': 'uid',
  '-g': 'primaryGroup', '--gid': 'primaryGroup',
  '-G': 'supplementaryGroups', '--groups': 'supplementaryGroups',
  '-d': 'home', '--home-dir': 'home', '--home': 'home',
  '-b': 'baseDir', '--base-dir': 'baseDir',
  '-s': 'shell', '--shell': 'shell',
  '-c': 'comment', '--comment': 'comment',
  '-p': 'passwordHash', '--password': 'passwordHash',
  '-e': 'expireDate', '--expiredate': 'expireDate',
  '-f': 'inactiveDays', '--inactive': 'inactiveDays',
  '-k': 'skeletonDir', '--skel': 'skeletonDir',
};

/** Boolean flags that take no argument. */
const BOOLEAN_OPTIONS: Record<string, keyof UseraddRequest> = {
  '-m': 'createHome', '--create-home': 'createHome',
  '-M': 'noCreateHome', '--no-create-home': 'noCreateHome',
  '-r': 'systemAccount', '--system': 'systemAccount',
  '-o': 'nonUnique', '--non-unique': 'nonUnique',
  '-N': 'noUserGroup', '--no-user-group': 'noUserGroup',
  '-U': 'userGroup', '--user-group': 'userGroup',
};

// ─── Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a token list (the arguments *after* the `useradd` word) into a
 * structured request. Never throws — malformed input is reflected in
 * `username === ''` or `unknownOptions`.
 */
export function parseUseraddArgs(tokens: string[]): UseraddRequest {
  const req: UseraddRequest = {
    username: '',
    supplementaryGroups: [],
    createHome: false,
    noCreateHome: false,
    systemAccount: false,
    nonUnique: false,
    noUserGroup: false,
    userGroup: false,
    unknownOptions: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token in BOOLEAN_OPTIONS) {
      (req as unknown as Record<string, unknown>)[BOOLEAN_OPTIONS[token]] = true;
      continue;
    }

    if (token in VALUE_OPTIONS) {
      const value = tokens[++i];
      if (value === undefined) continue;
      applyValue(req, VALUE_OPTIONS[token], value);
      continue;
    }

    // `--opt=value` long form.
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 0) {
      const name = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (name in VALUE_OPTIONS) {
        applyValue(req, VALUE_OPTIONS[name], value);
        continue;
      }
    }

    if (token.startsWith('-')) {
      req.unknownOptions.push(token);
      continue;
    }

    // A bare token is the login name (last one wins, matching useradd).
    req.username = token;
  }

  return req;
}

function applyValue(req: UseraddRequest, field: string, value: string): void {
  switch (field) {
    case 'uid': {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) req.uid = n;
      break;
    }
    case 'inactiveDays': {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) req.inactiveDays = n;
      break;
    }
    case 'supplementaryGroups':
      req.supplementaryGroups = value
        .split(',')
        .map((g) => g.trim())
        .filter((g) => g.length > 0);
      break;
    default:
      (req as unknown as Record<string, unknown>)[field] = value;
  }
}
