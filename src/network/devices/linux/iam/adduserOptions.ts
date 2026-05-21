/**
 * adduserOptions — shared parser for the Debian/Ubuntu `adduser` front-end.
 *
 * `adduser` (and its `addgroup` alias) is the high-level, *interactive*
 * account tool: unlike `useradd` it always creates the home directory,
 * copies `/etc/skel`, sets up a user-private group, and — for a normal
 * account — prompts for a password and the GECOS finger fields.
 *
 * It is also overloaded:
 *   - `adduser <user>`            → create a user
 *   - `adduser <user> <group>`    → add an existing user to a group
 *   - `adduser --group <group>`   → create a group  (same as `addgroup`)
 *   - `adduser --system <user>`   → create a non-interactive system account
 *
 * This module is the single authority for turning an `adduser` token list
 * into a structured {@link AdduserRequest}; both the command handler and the
 * interactive-flow builder consume it so they never disagree.
 */

// ─── Parsed request ─────────────────────────────────────────────────────

/** Which overloaded operation an `adduser` invocation requests. */
export type AdduserMode = 'create-user' | 'add-to-group' | 'create-group';

export interface AdduserRequest {
  /** Operation resolved from the flags and positional arguments. */
  mode: AdduserMode;
  /** Primary name — the login (create-user / add-to-group) or group name. */
  name: string;
  /** Second positional — the target group for `add-to-group`. */
  group: string;
  /** `--system` — a daemon/service account (non-interactive). */
  system: boolean;
  /** `--uid` explicit UID. */
  uid?: number;
  /** `--gid` explicit primary GID. */
  gid?: number;
  /** `--ingroup` — join an existing group as primary (no user-private group). */
  ingroup?: string;
  /** `--home` home directory path. */
  home?: string;
  /** `--shell` login shell. */
  shell?: string;
  /** `--gecos` GECOS string (suppresses the interactive finger prompts). */
  gecos?: string;
  /** `--disabled-password` / `--disabled-login` (suppresses the password prompt). */
  disabledPassword: boolean;
  /** `--no-create-home` — skip home-directory creation. */
  noCreateHome: boolean;
  /** Unrecognised options, surfaced for diagnostics. */
  unknownOptions: string[];
}

// ─── Option spec ────────────────────────────────────────────────────────

/** Long options that consume the following token as a value. */
const VALUE_OPTIONS: Record<string, keyof AdduserRequest> = {
  '--uid': 'uid',
  '--gid': 'gid',
  '--ingroup': 'ingroup',
  '--home': 'home',
  '--shell': 'shell',
  '--gecos': 'gecos',
};

/** Boolean options that take no argument. */
const BOOLEAN_OPTIONS: Record<string, 'system' | 'groupMode' | 'disabledPassword' | 'noCreateHome'> = {
  '--system': 'system',
  '--group': 'groupMode',
  '--disabled-password': 'disabledPassword',
  '--disabled-login': 'disabledPassword',
  '--no-create-home': 'noCreateHome',
};

// ─── Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a token list (the arguments *after* the `adduser` word) into a
 * structured request. `addGroupAlias` is set when the caller is the
 * `addgroup` command, which behaves like `adduser --group`.
 *
 * Never throws — malformed input is reflected in `name === ''`.
 */
export function parseAdduserArgs(tokens: string[], addGroupAlias = false): AdduserRequest {
  let groupMode = addGroupAlias;
  const req: AdduserRequest = {
    mode: 'create-user',
    name: '',
    group: '',
    system: false,
    disabledPassword: false,
    noCreateHome: false,
    unknownOptions: [],
  };
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token in BOOLEAN_OPTIONS) {
      const field = BOOLEAN_OPTIONS[token];
      if (field === 'groupMode') groupMode = true;
      else req[field] = true;
      continue;
    }

    if (token in VALUE_OPTIONS) {
      const value = tokens[++i];
      if (value !== undefined) applyValue(req, VALUE_OPTIONS[token], value);
      continue;
    }

    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 0) {
      const name = token.slice(0, eq);
      if (name in VALUE_OPTIONS) {
        applyValue(req, VALUE_OPTIONS[name], token.slice(eq + 1));
        continue;
      }
      if (name in BOOLEAN_OPTIONS) continue;
    }

    if (token.startsWith('-')) {
      req.unknownOptions.push(token);
      continue;
    }

    positionals.push(token);
  }

  req.name = positionals[0] ?? '';
  req.group = positionals[1] ?? '';

  // Resolve the overloaded operation.
  if (groupMode) {
    req.mode = 'create-group';
  } else if (req.group) {
    req.mode = 'add-to-group';
  } else {
    req.mode = 'create-user';
  }

  return req;
}

function applyValue(req: AdduserRequest, field: keyof AdduserRequest, value: string): void {
  if (field === 'uid' || field === 'gid') {
    const n = parseInt(value, 10);
    if (!Number.isNaN(n)) (req as unknown as Record<string, unknown>)[field] = n;
    return;
  }
  (req as unknown as Record<string, unknown>)[field] = value;
}
