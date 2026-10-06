import type { PamConversationFlow, PamHandle } from '../PamHandle';
import { CAPABILITY_NAMES, type LinuxPamHost } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

const USER_CAP_FILE = '/etc/security/capability.conf';
const S_IWOTH = 0o002;

interface CapOptions {
  keepCaps: boolean;
  autoAuth: boolean;
  defer: boolean;
  confFile: string | null;
  fallback: string | null;
}

function parseArguments(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): CapOptions {
  const options: CapOptions = { keepCaps: false, autoAuth: false, defer: false, confFile: null, fallback: null };
  for (const argument of args) {
    if (argument === 'debug') continue;
    else if (argument.startsWith('config=')) options.confFile = argument.slice(7);
    else if (argument === 'keepcaps') options.keepCaps = true;
    else if (argument === 'autoauth') options.autoAuth = true;
    else if (argument.startsWith('default=')) options.fallback = argument.slice(8);
    else if (argument === 'defer') options.defer = true;
    else pamh.syslog('err', `unknown option; ${argument}`);
  }
  return options;
}

function capabilitiesFor(pamh: PamHandle<LinuxPamHost>, user: string, source: string): string | null {
  const groups = pamh.host.accounts.groupNames(user);
  if (pamh.host.accounts.findUser(user) === null) return null;
  const content = pamh.host.readFile(source);
  if (content === null) return null;
  if (source !== '/dev/null') {
    const stat = pamh.host.files.stat(source);
    if (stat === null || (stat.mode & S_IWOTH) !== 0) return null;
  }
  for (const line of content.split('\n')) {
    const fields = line.split(/[ \t]+/).filter((field) => field !== '');
    if (fields.length === 0 || fields[0].startsWith('#')) continue;
    for (const candidate of fields.slice(1)) {
      if (candidate === '*' || candidate === user) return fields[0];
      if (candidate.startsWith('@') && groups.includes(candidate.slice(1))) return fields[0];
    }
  }
  return null;
}

function applyIab(pamh: PamHandle<LinuxPamHost>, text: string): boolean {
  const inheritable = new Set(pamh.host.process.capabilities.inheritable);
  const ambient = new Set(pamh.host.process.capabilities.ambient);
  const bounding = new Set(pamh.host.process.capabilities.bounding);
  for (const item of text.split(',')) {
    const prefix = /^[!^]?/.exec(item)?.[0] ?? '';
    const name = item.slice(prefix.length).toLowerCase();
    if (!(CAPABILITY_NAMES as readonly string[]).includes(name)) return false;
    if (prefix === '!') bounding.delete(name);
    else if (prefix === '^') { ambient.add(name); inheritable.add(name); }
    else inheritable.add(name);
  }
  for (const name of ambient) if (!inheritable.has(name) || !bounding.has(name)) ambient.delete(name);
  const state = pamh.host.process.capabilities;
  state.inheritable = inheritable;
  state.ambient = ambient;
  state.bounding = bounding;
  return true;
}

function setCapabilities(pamh: PamHandle<LinuxPamHost>, options: CapOptions, user: string): boolean {
  let configured = capabilitiesFor(pamh, user, options.confFile ?? USER_CAP_FILE);
  if (configured === null) {
    if (options.fallback === null) return false;
    configured = options.fallback;
  }
  if (configured === 'all') return true;
  const state = pamh.host.process.capabilities;
  if (configured === 'none') {
    state.inheritable = new Set();
    state.ambient = new Set();
    return true;
  }
  const applied = applyIab(pamh, configured);
  if (options.keepCaps) state.keepCaps = true;
  return applied;
}

function* authenticate(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  const options = parseArguments(pamh, args);
  const lookup = yield* pamh.getUser();
  if (options.autoAuth) return PamReturn.SUCCESS;
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) return PamReturn.AUTH_ERR;
  const configured = capabilitiesFor(pamh, lookup.value, options.confFile ?? USER_CAP_FILE);
  return configured === null ? PamReturn.IGNORE : PamReturn.SUCCESS;
}

function setcred(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): number {
  if ((flags & (PamFlag.ESTABLISH_CRED | PamFlag.REINITIALIZE_CRED)) === 0) return PamReturn.IGNORE;
  const options = parseArguments(pamh, args);
  const user = pamh.user;
  if (user === null || user === '') return PamReturn.AUTH_ERR;
  return setCapabilities(pamh, options, user) ? PamReturn.SUCCESS : PamReturn.IGNORE;
}

export const pamCapModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => authenticate(pamh, args),
  setcred: (pamh, flags, args) => setcred(pamh, flags, args),
};
