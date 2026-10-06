import type { PasswordQualityPolicyInit } from './PasswordQualityPolicy';

const INTEGER_OPTIONS: Readonly<Record<string, keyof PasswordQualityPolicyInit>> = {
  difok: 'difOk',
  minlen: 'minLength',
  dcredit: 'digitCredit',
  ucredit: 'uppercaseCredit',
  lcredit: 'lowercaseCredit',
  ocredit: 'otherCredit',
  minclass: 'minClasses',
  maxrepeat: 'maxRepeat',
  maxclassrepeat: 'maxClassRepeat',
  maxsequence: 'maxSequence',
  usersubstr: 'userSubstr',
  retry: 'retry',
};

const BOOLEAN_OPTIONS: Readonly<Record<string, keyof PasswordQualityPolicyInit>> = {
  gecoscheck: 'gecosCheck',
  dictcheck: 'dictCheck',
  usercheck: 'userCheck',
  enforcing: 'enforcing',
  enforce_for_root: 'enforceForRoot',
  local_users_only: 'localUsersOnly',
};

const BARE_FLAGS: ReadonlySet<string> = new Set(['enforce_for_root', 'local_users_only']);

function parseInteger(text: string): number | null {
  const match = /^\s*([+-]?\d+)\s*$/.exec(text);
  return match === null ? null : parseInt(match[1], 10);
}

export function applyPwqualityOption(init: PasswordQualityPolicyInit, option: string): boolean {
  const equals = option.indexOf('=');
  const name = (equals < 0 ? option : option.slice(0, equals)).trim().toLowerCase();
  const value = equals < 0 ? null : option.slice(equals + 1).trim();
  const target = init as Record<string, unknown>;
  if (name in INTEGER_OPTIONS) {
    const parsed = value === null ? null : parseInteger(value);
    if (parsed === null) return false;
    target[INTEGER_OPTIONS[name]] = parsed;
    return true;
  }
  if (name in BOOLEAN_OPTIONS) {
    if (value === null) {
      if (!BARE_FLAGS.has(name)) return false;
      target[BOOLEAN_OPTIONS[name]] = true;
      return true;
    }
    const parsed = parseInteger(value);
    if (parsed !== null) target[BOOLEAN_OPTIONS[name]] = parsed !== 0;
    else if (value === 'true' || value === 'false') target[BOOLEAN_OPTIONS[name]] = value === 'true';
    else return false;
    return true;
  }
  if (name === 'dictpath' && value !== null) {
    init.dictPath = value;
    return true;
  }
  if (name === 'badwords' && value !== null) {
    init.badWords = value.split(/\s+/).filter((word) => word !== '').map((word) => word.toLowerCase());
    return true;
  }
  return false;
}

export function readPwqualityConfig(content: string): { init: PasswordQualityPolicyInit; rejected: string[] } {
  const init: PasswordQualityPolicyInit = {};
  const rejected: string[] = [];
  for (const raw of content.split('\n')) {
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (line === '') continue;
    if (!applyPwqualityOption(init, line)) rejected.push(line);
  }
  return { init, rejected };
}
