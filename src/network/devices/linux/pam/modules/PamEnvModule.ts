import type { PamHandle } from '../PamHandle';
import type { PamModuleImplementation } from '../PamModule';
import type { LinuxPamHost } from '../PamLinuxHost';
import { PamReturn } from '../PamReturnCode';
import { assemblePamLines } from '../PamStackConfig';

const DEFAULT_CONF_FILE = '/etc/security/pam_env.conf';
const DEFAULT_ETC_ENVFILE = '/etc/environment';
const DEFAULT_USER_ENVFILE = '.pam_environment';
const MAX_ENV = 8192;

const BAD_LINE = 100;
const ILLEGAL_VAR = 103;
const GOOD_LINE = 0;

interface EnvOptions {
  debug: boolean;
  confFile: string;
  envFile: string;
  userEnvFile: string;
  readEnv: boolean;
  userReadEnv: boolean;
}

interface ParsedVariable {
  name: string;
  defval: string | null;
  override: string | null;
}

function parseOptions(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): EnvOptions {
  const options: EnvOptions = {
    debug: false,
    confFile: DEFAULT_CONF_FILE,
    envFile: DEFAULT_ETC_ENVFILE,
    userEnvFile: DEFAULT_USER_ENVFILE,
    readEnv: true,
    userReadEnv: false,
  };
  const pathOption = (argument: string, prefix: string, assign: (value: string) => void): boolean => {
    if (!argument.startsWith(prefix)) return false;
    const value = argument.slice(prefix.length);
    if (value === '') pamh.syslog('err', `${prefix} specification missing argument - ignored`);
    else assign(value);
    return true;
  };
  for (const argument of args) {
    if (argument === 'debug') options.debug = true;
    else if (pathOption(argument, 'conffile=', (value) => { options.confFile = value; })) continue;
    else if (pathOption(argument, 'envfile=', (value) => { options.envFile = value; })) continue;
    else if (pathOption(argument, 'user_envfile=', (value) => { options.userEnvFile = value; })) continue;
    else if (argument.startsWith('readenv=')) options.readEnv = (parseInt(argument.slice(8), 10) || 0) !== 0;
    else if (argument.startsWith('user_readenv=')) options.userReadEnv = (parseInt(argument.slice(13), 10) || 0) !== 0;
    else pamh.syslog('err', `unknown option: ${argument}`);
  }
  return options;
}

function parseLine(pamh: PamHandle<LinuxPamHost>, line: string): { code: number; variable: ParsedVariable | null } {
  const nameLength = line.search(/[ \t\n]|$/);
  const variable: ParsedVariable = { name: line.slice(0, nameLength), defval: null, override: null };
  let rest = line.slice(nameLength);
  for (;;) {
    const spaces = /^[ \t]*/.exec(rest)?.[0].length ?? 0;
    if (spaces === 0) break;
    rest = rest.slice(spaces);
    let target: 'defval' | 'override';
    if (rest.startsWith('DEFAULT=')) {
      target = 'defval';
      rest = rest.slice(8);
    } else if (rest.startsWith('OVERRIDE=')) {
      target = 'override';
      rest = rest.slice(9);
    } else {
      pamh.syslog('err', `Unrecognized Option: ${rest} - ignoring line`);
      return { code: BAD_LINE, variable: null };
    }
    let value: string;
    let quoted = false;
    if (!rest.startsWith('"')) {
      const length = rest.search(/[ \t\n]|$/);
      value = rest.slice(0, length);
      rest = rest.slice(length);
    } else {
      const close = rest.indexOf('"', 1);
      if (close < 0) {
        pamh.syslog('err', `Unterminated quoted string: ${rest}`);
        return { code: BAD_LINE, variable: null };
      }
      value = rest.slice(1, close);
      rest = rest.slice(close + 1);
      if (rest !== '' && !/^[ \t\n]/.test(rest)) {
        pamh.syslog('err', `Quotes must cover the entire string: <${value}>`);
        return { code: BAD_LINE, variable: null };
      }
      quoted = true;
    }
    if (value !== '' || quoted) variable[target] = value;
  }
  return { code: GOOD_LINE, variable };
}

function itemByName(pamh: PamHandle<LinuxPamHost>, name: string): string | null {
  const userItem = name === 'PAM_USER' || name === 'HOME' || name === 'SHELL';
  let value: string | null;
  if (userItem) value = pamh.user;
  else if (name === 'PAM_USER_PROMPT') value = pamh.userPrompt;
  else if (name === 'PAM_TTY') value = pamh.tty;
  else if (name === 'PAM_RUSER') value = pamh.ruser;
  else if (name === 'PAM_RHOST') value = pamh.rhost;
  else {
    pamh.syslog('err', `Unknown PAM_ITEM: <${name}>`);
    return null;
  }
  if (value !== null && (name === 'HOME' || name === 'SHELL')) {
    const account = pamh.host.accounts.findUser(value);
    if (account === null) {
      pamh.syslog('err', 'No such user!?');
      return null;
    }
    return name === 'SHELL' ? account.shell : account.home;
  }
  return value;
}

function expandArgument(pamh: PamHandle<LinuxPamHost>, original: string): { code: number; value: string } {
  let output = '';
  let index = 0;
  while (index < original.length) {
    const character = original[index];
    if (character === '\\') {
      index++;
      const escaped = original[index] ?? '';
      if (escaped !== '$' && escaped !== '@') {
        pamh.syslog('err', `Unrecognized escaped character: <${escaped}> - ignoring`);
      } else {
        output += escaped;
        index++;
      }
      continue;
    }
    if (character === '$' || character === '@') {
      if (original[index + 1] !== '{') {
        pamh.syslog('err', `Expandable variables must be wrapped in {} <${original.slice(index)}> - ignoring`);
        output += character;
        index++;
        continue;
      }
      const close = original.indexOf('}', index + 2);
      if (close < 0) {
        pamh.syslog('err', `Unterminated expandable variable: <${original.slice(index)}>`);
        return { code: PamReturn.ABORT, value: '' };
      }
      const name = original.slice(index + 2, close);
      index = close + 1;
      const expanded = character === '$' ? pamh.getenv(name) : itemByName(pamh, name);
      if (expanded !== null) {
        if (output.length + expanded.length >= MAX_ENV) {
          pamh.syslog('err', `Variable buffer overflow: <${output}> + <${expanded}>`);
          return { code: PamReturn.BUF_ERR, value: '' };
        }
        output += expanded;
      }
      continue;
    }
    if (output.length + 1 >= MAX_ENV) {
      pamh.syslog('err', `Variable buffer overflow: <${output}> + <>`);
      return { code: PamReturn.BUF_ERR, value: '' };
    }
    output += character;
    index++;
  }
  return { code: PamReturn.SUCCESS, value: output };
}

function applyVariable(pamh: PamHandle<LinuxPamHost>, options: EnvOptions, variable: ParsedVariable): number {
  let defval = variable.defval;
  let override = variable.override;
  if (defval !== null && defval !== '') {
    const expanded = expandArgument(pamh, defval);
    if (expanded.code !== PamReturn.SUCCESS) return expanded.code;
    defval = expanded.value;
  }
  if (override !== null && override !== '') {
    const expanded = expandArgument(pamh, override);
    if (expanded.code !== PamReturn.SUCCESS) return expanded.code;
    override = expanded.value;
  }
  let value: string | null;
  if (override !== null && override !== '') value = override;
  else if (defval !== null) value = defval;
  else value = null;
  if (value === null) {
    if (options.debug) pamh.syslog('debug', `remove variable "${variable.name}"`);
    return pamh.putenv(variable.name);
  }
  const assignment = `${variable.name}=${value}`;
  const code = pamh.putenv(assignment);
  if (options.debug) pamh.syslog('debug', `pam_putenv("${assignment}")`);
  return code;
}

function parseConfigFile(pamh: PamHandle<LinuxPamHost>, options: EnvOptions, path: string): number {
  const content = pamh.host.readFile(path);
  if (content === null) {
    pamh.syslog('err', `Unable to open config file: ${path}: No such file or directory`);
    return PamReturn.IGNORE;
  }
  for (const line of assemblePamLines(content)) {
    const parsed = parseLine(pamh, line);
    let code = parsed.code;
    if (code === GOOD_LINE && parsed.variable !== null) {
      if (parsed.variable.name === '') code = ILLEGAL_VAR;
      else code = applyVariable(pamh, options, parsed.variable);
    }
    if (code !== PamReturn.SUCCESS && code !== ILLEGAL_VAR && code !== BAD_LINE && code !== PamReturn.BAD_ITEM) {
      return PamReturn.ABORT;
    }
  }
  return PamReturn.SUCCESS;
}

function parseEnvFile(pamh: PamHandle<LinuxPamHost>, options: EnvOptions, path: string): number {
  const content = pamh.host.readFile(path);
  if (content === null) {
    pamh.syslog('err', `Unable to open env file: ${path}: No such file or directory`);
    return PamReturn.IGNORE;
  }
  for (const line of assemblePamLines(content)) {
    let key = line.replace(/^[ \n\t]+/, '');
    if (key.startsWith('#')) continue;
    if (key.startsWith('export ')) key = key.slice(7);
    const end = key.search(/[\n#]/);
    if (end >= 0) key = key.slice(0, end);
    if (key.startsWith('=')) {
      pamh.syslog('err', `missing key name '${key}' in ${path}', ignoring`);
      continue;
    }
    const equals = key.indexOf('=');
    const name = equals < 0 ? key : key.slice(0, equals);
    if (!/^[A-Za-z0-9_]*$/.test(name)) {
      pamh.syslog('err', `non-alphanumeric key '${key}' in ${path}', ignoring`);
      continue;
    }
    if (equals >= 0 && (key[equals + 1] === '"' || key[equals + 1] === '\'')) {
      let value = '';
      const body = key.slice(equals + 2);
      for (let position = 0; position < body.length; position++) {
        const character = body[position];
        if (character !== '"' && character !== '\'') value += character;
        else if (position + 1 < body.length) value += character;
      }
      key = `${name}=${value}`;
    }
    if (equals < 0 && pamh.getenv(key) === null) continue;
    const code = pamh.putenv(key);
    if (code !== PamReturn.SUCCESS) return code;
    if (options.debug) pamh.syslog('debug', `pam_putenv("${key}")`);
  }
  return PamReturn.SUCCESS;
}

function handleEnv(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): number {
  const options = parseOptions(pamh, args);
  let code = parseConfigFile(pamh, options, options.confFile);
  if (options.readEnv && code === PamReturn.SUCCESS) {
    code = parseEnvFile(pamh, options, options.envFile);
    if (code === PamReturn.IGNORE) code = PamReturn.SUCCESS;
  }
  if (options.userReadEnv && code === PamReturn.SUCCESS) {
    const username = itemByName(pamh, 'PAM_USER');
    const account = username === null ? null : pamh.host.accounts.findUser(username);
    if (account === null) {
      pamh.syslog('err', 'No such user!?');
    } else {
      const path = `${account.home}/${options.userEnvFile}`;
      if (pamh.host.files.exists(path)) {
        code = parseConfigFile(pamh, options, path);
        if (code === PamReturn.IGNORE) code = PamReturn.SUCCESS;
      }
    }
  }
  return code;
}

function inappropriate(pamh: PamHandle<LinuxPamHost>, entry: string): number {
  pamh.syslog('notice', `${entry} called inappropriately`);
  return PamReturn.SERVICE_ERR;
}

export const pamEnvModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: () => PamReturn.IGNORE,
  setcred: (pamh, _flags, args) => handleEnv(pamh, args),
  acctMgmt: (pamh) => inappropriate(pamh, 'pam_sm_acct_mgmt'),
  openSession: (pamh, _flags, args) => handleEnv(pamh, args),
  closeSession: () => PamReturn.SUCCESS,
  chauthtok: (pamh) => inappropriate(pamh, 'pam_sm_chauthtok'),
};
