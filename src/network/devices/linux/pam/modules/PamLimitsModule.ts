import type { PamConversationFlow, PamHandle } from '../PamHandle';
import {
  PAM_RLIMIT_RESOURCES,
  type LinuxPamHost,
  type PamRlimit,
  type PamRlimitResource,
} from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamReturn } from '../PamReturnCode';

const LIMITS_FILE = '/etc/security/limits.conf';
const LIMITS_DIRECTORY = '/etc/security/limits.d';
const NR_OPEN = 1_048_576;
const INFINITY = Number.POSITIVE_INFINITY;

const SOURCE_USER = 0;
const SOURCE_GROUP = 1;
const SOURCE_ALLGROUP = 2;
const SOURCE_ALL = 3;
const SOURCE_DEFAULT = 4;
const SOURCE_KERNEL = 5;
const SOURCE_NONE = 6;

const SOURCE_NAMES = ['USER', 'GROUP', 'ALLGROUP', 'ALL', 'DEFAULT', 'KERNEL', 'NONE'];

const KERNEL_LIMIT_NAMES: Readonly<Record<string, PamRlimitResource>> = {
  'Max cpu time': 'cpu',
  'Max file size': 'fsize',
  'Max data size': 'data',
  'Max stack size': 'stack',
  'Max core file size': 'core',
  'Max resident set': 'rss',
  'Max processes': 'nproc',
  'Max open files': 'nofile',
  'Max locked memory': 'memlock',
  'Max address space': 'as',
  'Max file locks': 'locks',
  'Max pending signals': 'sigpending',
  'Max msgqueue size': 'msgqueue',
  'Max nice priority': 'nice',
  'Max realtime priority': 'rtprio',
  'Max realtime timeout': 'rttime',
};

type Range = 'error' | 'none' | 'one' | 'min' | 'mm';

interface SourcedLimit {
  limit: PamRlimit;
  softSource: number;
  hardSource: number;
}

interface LimitsState {
  debug: boolean;
  utmpEarly: boolean;
  setAll: boolean;
  confFile: string | null;
  loginLimit: number;
  loginLimitSource: number;
  numSysLogins: boolean;
  priority: number;
  loginGroup: string;
  limits: Map<PamRlimitResource, SourcedLimit>;
}

function parseOptions(pamh: PamHandle<LinuxPamHost>, args: readonly string[], state: LimitsState): void {
  for (const argument of args) {
    if (argument === 'debug') state.debug = true;
    else if (argument.startsWith('conf=')) state.confFile = argument.slice(5);
    else if (argument === 'utmp_early') state.utmpEarly = true;
    else if (argument === 'noaudit') continue;
    else if (argument === 'set_all') state.setAll = true;
    else pamh.syslog('err', `unknown option: ${argument}`);
  }
}

function parseKernelLimits(pamh: PamHandle<LinuxPamHost>, state: LimitsState): void {
  const content = pamh.host.readFile('/proc/1/limits');
  if (content === null) {
    pamh.syslog('warning', 'Could not read /proc/1/limits (No such file or directory), using PAM defaults');
    return;
  }
  const toNumber = (text: string): number => (text === 'unlimited' ? INFINITY : Number(text));
  for (const line of content.split('\n')) {
    const match = /^(Max .+?)\s{2,}(\S+)\s+(\S+)(?:\s+\S+)?$/.exec(line.trimEnd());
    if (match === null) continue;
    const resource = KERNEL_LIMIT_NAMES[match[1]];
    if (resource === undefined) {
      if (state.debug) pamh.syslog('debug', `Unknown kernel rlimit '${match[1]}' ignored`);
      continue;
    }
    state.limits.set(resource, {
      limit: { soft: toNumber(match[2]), hard: toNumber(match[3]) },
      softSource: SOURCE_KERNEL,
      hardSource: SOURCE_KERNEL,
    });
  }
}

function initLimits(pamh: PamHandle<LinuxPamHost>, state: LimitsState): void {
  for (const resource of PAM_RLIMIT_RESOURCES) {
    const current = pamh.host.process.limits.get(resource) ?? { soft: INFINITY, hard: INFINITY };
    state.limits.set(resource, { limit: { ...current }, softSource: SOURCE_NONE, hardSource: SOURCE_NONE });
  }
  if (state.setAll) {
    parseKernelLimits(pamh, state);
    for (const [resource, entry] of state.limits) {
      if (entry.softSource === SOURCE_NONE || entry.hardSource === SOURCE_NONE) {
        pamh.syslog('warning', `Did not find kernel RLIMIT for ${resource}, using PAM default`);
      }
    }
  }
  state.priority = pamh.host.process.priority;
  state.loginLimit = -2;
  state.loginLimitSource = SOURCE_NONE;
}

function parseInteger(text: string): number | null {
  const match = /^\s*([+-]?\d+)/.exec(text);
  if (match === null) return null;
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, parseInt(match[1], 10)));
}

function parseUnsigned(text: string): number | null {
  const match = /^\s*\+?(\d+)/.exec(text);
  return match === null ? null : Number(match[1]);
}

function processLimit(
  pamh: PamHandle<LinuxPamHost>, state: LimitsState, source: number, type: string, item: string, value: string,
): void {
  if (state.debug) pamh.syslog('debug', `processLimit: processing ${type} ${item} ${value} for ${SOURCE_NAMES[source]}`);
  const resource = (PAM_RLIMIT_RESOURCES as readonly string[]).includes(item) ? item as PamRlimitResource : null;
  const isLogin = item === 'maxlogins';
  const isSysLogin = item === 'maxsyslogins';
  const isPriority = item === 'priority';
  if (resource === null && !isLogin && !isSysLogin && !isPriority) {
    pamh.syslog('debug', `unknown limit item '${item}'`);
    return;
  }
  if (isLogin) state.numSysLogins = false;
  if (isSysLogin) state.numSysLogins = true;
  let soft = false;
  let hard = false;
  if (type === 'soft') soft = true;
  else if (type === 'hard') hard = true;
  else if (type === '-') { soft = true; hard = true; }
  else if (!isLogin && !isSysLogin) {
    pamh.syslog('debug', `unknown limit type '${type}'`);
    return;
  }
  const isNice = resource === 'nice';
  const integerItem = isPriority || isLogin || isNice || isSysLogin;
  let integerValue = 0;
  let rlimitValue = 0;
  if (!isPriority && !isNice && ['-1', '-', 'unlimited', 'infinity'].includes(value)) {
    integerValue = -1;
    rlimitValue = INFINITY;
  } else if (integerItem) {
    const parsed = parseInteger(value);
    if (parsed === null) {
      pamh.syslog('debug', `wrong limit value '${value}' for limit type '${type}'`);
      return;
    }
    integerValue = parsed;
  } else {
    const parsed = parseUnsigned(value);
    if (parsed === null) {
      pamh.syslog('debug', `wrong limit value '${value}' for limit type '${type}'`);
      return;
    }
    rlimitValue = parsed;
  }
  if ((source === SOURCE_ALL || source === SOURCE_ALLGROUP) && !isLogin) {
    if (state.debug) pamh.syslog('debug', '\'%\' domain valid for maxlogins type only');
    return;
  }
  if (resource === 'cpu' && rlimitValue !== INFINITY) rlimitValue *= 60;
  else if (resource !== null && ['fsize', 'data', 'stack', 'core', 'rss', 'memlock', 'as'].includes(resource) && rlimitValue !== INFINITY) {
    rlimitValue *= 1024;
  } else if (isNice) {
    integerValue = Math.max(-20, Math.min(19, integerValue));
    rlimitValue = 20 - integerValue;
  }
  if (resource !== null) {
    const entry = state.limits.get(resource);
    if (entry === undefined) return;
    if (soft) {
      if (entry.softSource < source) return;
      entry.limit.soft = rlimitValue;
      entry.softSource = source;
    }
    if (hard) {
      if (entry.hardSource < source) return;
      entry.limit.hard = rlimitValue;
      entry.hardSource = source;
    }
    return;
  }
  if (isPriority) {
    state.priority = integerValue;
  } else if (state.loginLimitSource >= source) {
    state.loginLimit = integerValue;
    state.loginLimitSource = source;
  }
}

function parseUidRange(
  pamh: PamHandle<LinuxPamHost>, domain: string,
): { kind: Range; min: number; max: number } {
  let min = -1;
  let max = -1;
  const colon = domain.indexOf(':');
  if (colon < 0) return { kind: 'none', min, max };
  const upper = domain.slice(colon + 1);
  const lowerStart = domain[0] === '@' || domain[0] === '%' ? 1 : 0;
  const lowerText = domain.slice(lowerStart, colon);
  let kind: Range = 'mm';
  if (lowerStart === colon) kind = 'one';
  else {
    if (!/^\d+$/.test(lowerText)) {
      pamh.syslog('debug', `wrong min_uid/gid value in '${domain}'`);
      return { kind: 'error', min, max };
    }
    min = Number(lowerText);
  }
  if (upper === '') return { kind: kind === 'one' ? 'error' : 'min', min, max };
  if (!/^\d+$/.test(upper)) {
    pamh.syslog('debug', `wrong max_uid/gid value in '${domain}'`);
    return { kind: 'error', min, max };
  }
  max = Number(upper);
  if (kind === 'one') min = max;
  return { kind, min, max };
}

function rangeMatches(range: { kind: Range; min: number; max: number }, id: number): boolean {
  if (range.kind === 'one') return id === range.max;
  if (range.kind === 'mm') return id >= range.min && id <= range.max;
  return id >= range.min;
}

interface Applicant {
  name: string;
  uid: number;
  gid: number;
}

function parseConfigFile(pamh: PamHandle<LinuxPamHost>, state: LimitsState, applicant: Applicant, path: string): number {
  if (state.debug) pamh.syslog('debug', `reading settings from '${path}'`);
  const content = pamh.host.readFile(path);
  if (content === null) {
    pamh.syslog('warning', `cannot read settings from ${path}: No such file or directory`);
    return PamReturn.SERVICE_ERR;
  }
  const inGroup = (group: string): boolean => pamh.host.accounts.groupNames(applicant.name).includes(group);
  const inGid = (gid: number): boolean => {
    const group = pamh.host.accounts.findGroupByGid(gid);
    return group !== null && inGroup(group.name);
  };
  for (const raw of content.split('\n')) {
    const stripped = raw.replace(/^\s+/, '');
    const hash = stripped.indexOf('#');
    const line = hash >= 0 ? stripped.slice(0, hash) : stripped;
    if (line.length === 0) continue;
    const tokens = line.split(/\s+/).filter((token) => token !== '').slice(0, 4);
    const domain = tokens[0] ?? '';
    const type = (tokens[1] ?? '').toLowerCase();
    const count = tokens.length;
    const range = parseUidRange(pamh, domain);
    if (range.kind === 'error') {
      pamh.syslog('warning', `invalid uid range '${domain}' - skipped`);
      continue;
    }
    if (count === 4) {
      const item = tokens[2].toLowerCase();
      const value = tokens[3].toLowerCase();
      if (applicant.name === domain) {
        processLimit(pamh, state, SOURCE_USER, type, item, value);
      } else if (domain[0] === '@') {
        if (state.debug) pamh.syslog('debug', `checking if ${applicant.name} is in group ${domain.slice(1)}`);
        let applies = false;
        if (range.kind === 'none') applies = inGroup(domain.slice(1));
        else if (range.kind === 'one') applies = inGid(range.max);
        else if (range.kind === 'mm') applies = applicant.gid <= range.max && applicant.gid >= range.min;
        else applies = applicant.gid >= range.min;
        if (applies) processLimit(pamh, state, SOURCE_GROUP, type, item, value);
      } else if (domain[0] === '%') {
        if (state.debug) pamh.syslog('debug', `checking if ${applicant.name} is in group ${domain.slice(1)}`);
        if (range.kind === 'none') {
          if (domain === '%') processLimit(pamh, state, SOURCE_ALL, type, item, value);
          else if (inGroup(domain.slice(1))) {
            state.loginGroup = domain.slice(1);
            processLimit(pamh, state, SOURCE_ALLGROUP, type, item, value);
          }
        } else if (range.kind === 'one') {
          if (inGid(range.max)) {
            state.loginGroup = pamh.host.accounts.findGroupByGid(range.max)?.name ?? '';
            processLimit(pamh, state, SOURCE_ALLGROUP, type, item, value);
          }
        } else {
          pamh.syslog('warning', 'range unsupported for %group matching - ignored');
        }
      } else if (range.kind === 'none') {
        if (domain === '*') processLimit(pamh, state, SOURCE_DEFAULT, type, item, value);
      } else if (rangeMatches(range, applicant.uid)) {
        processLimit(pamh, state, SOURCE_USER, type, item, value);
      }
    } else if (count === 2 && type[0] === '-') {
      if (applicant.name === domain) {
        if (state.debug) pamh.syslog('debug', `no limits for '${applicant.name}'`);
      } else if (domain[0] === '@') {
        let applies: boolean;
        if (range.kind === 'none') applies = inGroup(domain.slice(1));
        else if (range.kind === 'one') applies = inGid(range.max);
        else if (range.kind === 'mm') applies = applicant.gid <= range.max && applicant.gid >= range.min;
        else applies = applicant.gid >= range.min;
        if (!applies) continue;
        if (state.debug) pamh.syslog('debug', `no limits for '${applicant.name}' in group '${domain.slice(1)}'`);
      } else {
        if (range.kind === 'none' || !rangeMatches(range, applicant.uid)) continue;
        if (state.debug) pamh.syslog('debug', `no limits for '${applicant.name}'`);
      }
      return PamReturn.IGNORE;
    } else {
      pamh.syslog('warning', `invalid line '${line}' - skipped`);
    }
  }
  return PamReturn.SUCCESS;
}

function checkLogins(pamh: PamHandle<LinuxPamHost>, state: LimitsState, name: string, limit: number): boolean {
  if (state.debug) pamh.syslog('debug', `checking logins for '${name}' (maximum of ${limit})`);
  if (limit < 0) return true;
  if (limit === 0) {
    pamh.syslog('warning', `No logins allowed for '${name}'`);
    return false;
  }
  let count = state.utmpEarly ? 0 : 1;
  for (const login of pamh.host.logins()) {
    if (!state.numSysLogins) {
      const sameUserOnly = state.loginLimitSource === SOURCE_USER
        || state.loginLimitSource === SOURCE_GROUP
        || state.loginLimitSource === SOURCE_DEFAULT;
      if (sameUserOnly && login.user !== name) continue;
      if (state.loginLimitSource === SOURCE_ALLGROUP && !pamh.host.accounts.groupNames(login.user).includes(state.loginGroup)) continue;
    }
    count++;
    if (count > limit) break;
  }
  if (count > limit) {
    pamh.syslog('notice', `Too many logins (max ${limit}) for ${name}`);
    return false;
  }
  return true;
}

function setupLimits(pamh: PamHandle<LinuxPamHost>, state: LimitsState, applicant: Applicant): { limitError: boolean; loginError: boolean } {
  const process = pamh.host.process;
  const privileged = pamh.host.caller.euid === 0;
  let limitError = false;
  for (const resource of PAM_RLIMIT_RESOURCES) {
    const entry = state.limits.get(resource);
    if (entry === undefined || (entry.softSource === SOURCE_NONE && entry.hardSource === SOURCE_NONE)) continue;
    if (entry.limit.soft > entry.limit.hard) entry.limit.soft = entry.limit.hard;
    const current = process.limits.get(resource) ?? { soft: INFINITY, hard: INFINITY };
    const raisesHard = entry.limit.hard > current.hard;
    const beyondKernel = resource === 'nofile' && entry.limit.hard > NR_OPEN;
    if ((raisesHard && !privileged) || beyondKernel) {
      pamh.syslog('err', `Could not set limit for '${resource}': Operation not permitted`);
      limitError = true;
      continue;
    }
    process.limits.set(resource, { ...entry.limit });
  }
  if (state.priority < process.priority && !privileged) {
    pamh.syslog('err', 'Could not set limit for PRIO_PROCESS: Permission denied');
    limitError = true;
  } else {
    process.priority = state.priority;
  }
  let loginError = false;
  if (applicant.uid === 0) {
    loginError = false;
  } else if (state.loginLimit > 0) {
    loginError = !checkLogins(pamh, state, applicant.name, state.loginLimit);
  } else if (state.loginLimit === 0) {
    loginError = true;
  }
  return { limitError, loginError };
}

function* openSession(pamh: PamHandle<LinuxPamHost>, _flags: number, args: readonly string[]): PamConversationFlow<number> {
  const state: LimitsState = {
    debug: false, utmpEarly: false, setAll: false, confFile: null, loginLimit: -2, loginLimitSource: SOURCE_NONE,
    numSysLogins: false, priority: 0, loginGroup: '', limits: new Map(),
  };
  parseOptions(pamh, args, state);
  const userName = pamh.user;
  if (userName === null) {
    pamh.syslog('err', 'open_session - error recovering username');
    return PamReturn.SESSION_ERR;
  }
  const account = pamh.host.accounts.findUser(userName);
  if (account === null) {
    if (state.debug) pamh.syslog('warning', `open_session username '${userName}' does not exist`);
    return PamReturn.USER_UNKNOWN;
  }
  const applicant: Applicant = { name: account.name, uid: account.uid, gid: account.gid };
  initLimits(pamh, state);
  const files = state.confFile !== null ? [state.confFile] : [LIMITS_FILE];
  if (state.confFile === null) {
    const names = (pamh.host.files.listDirectory(LIMITS_DIRECTORY) ?? []).filter((name) => name.endsWith('.conf')).sort();
    for (const name of names) files.push(`${LIMITS_DIRECTORY}/${name}`);
  }
  let configFile = files[0];
  for (const file of files) {
    configFile = file;
    const code = parseConfigFile(pamh, state, applicant, file);
    if (code === PamReturn.IGNORE) return PamReturn.SUCCESS;
    if (code !== PamReturn.SUCCESS) {
      pamh.syslog('err', `error parsing the configuration file: '${configFile}' `);
      return code;
    }
  }
  const outcome = setupLimits(pamh, state, applicant);
  if (outcome.loginError) yield* pamh.notify('error', `There were too many logins for '${applicant.name}'.`);
  return outcome.limitError || outcome.loginError ? PamReturn.PERM_DENIED : PamReturn.SUCCESS;
}

export const pamLimitsModule: PamModuleImplementation<LinuxPamHost> = {
  openSession,
  closeSession: () => PamReturn.SUCCESS,
};

