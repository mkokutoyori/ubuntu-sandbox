import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost, PamUserRecord } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

const DEFAULT_MAIL_DIRECTORY = '/var/mail';
const MAIL_ENV_NAME = 'MAIL';

const HAVE_NEW_MAIL = 1;
const HAVE_OLD_MAIL = 2;
const HAVE_NO_MAIL = 3;
const HAVE_MAIL = 4;

interface MailOptions {
  debug: boolean;
  noLogin: boolean;
  logoutToo: boolean;
  newMailDirectory: boolean;
  silent: boolean;
  noEnv: boolean;
  emptyToo: boolean;
  standard: boolean;
  quiet: boolean;
  directory: string;
  hashCount: number;
}

function parseOptions(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): MailOptions {
  const options: MailOptions = {
    debug: false, noLogin: false, logoutToo: false, newMailDirectory: false, silent: (flags & PamFlag.SILENT) !== 0,
    noEnv: false, emptyToo: false, standard: false, quiet: false, directory: DEFAULT_MAIL_DIRECTORY, hashCount: 0,
  };
  for (const argument of args) {
    if (argument === 'debug') options.debug = true;
    else if (argument === 'quiet') options.quiet = true;
    else if (argument === 'standard') { options.standard = true; options.emptyToo = true; }
    else if (argument.startsWith('dir=')) {
      const value = argument.slice(4);
      if (value !== '') { options.directory = value; options.newMailDirectory = true; }
      else pamh.syslog('err', 'dir= specification missing argument - ignored');
    } else if (argument.startsWith('hash=')) options.hashCount = Math.max(0, parseInt(argument.slice(5), 10) || 0);
    else if (argument === 'close') options.logoutToo = true;
    else if (argument === 'nopen') options.noLogin = true;
    else if (argument === 'noenv') options.noEnv = true;
    else if (argument === 'empty') options.emptyToo = true;
    else pamh.syslog('err', `unknown option: ${argument}`);
  }
  if (options.hashCount !== 0 && !options.newMailDirectory) {
    options.directory = DEFAULT_MAIL_DIRECTORY;
    options.newMailDirectory = true;
  }
  return options;
}

function folderOf(pamh: PamHandle<LinuxPamHost>, options: MailOptions, user: PamUserRecord): string | null {
  let path = options.newMailDirectory ? options.directory : DEFAULT_MAIL_DIRECTORY;
  let homeMail = false;
  if (options.newMailDirectory && path.startsWith('~')) {
    path = path.slice(1);
    if (path.startsWith('/')) path = path.slice(1);
    if (path === '') {
      pamh.syslog('err', `badly formed mail path [${options.directory}]`);
      return null;
    }
    homeMail = true;
    if (options.hashCount !== 0) pamh.syslog('err', 'cannot do hash= and home directory mail');
  }
  if (homeMail) return `${user.home}/${path}`;
  const count = Math.min(options.hashCount, user.name.length);
  let hash = '';
  for (let index = 0; index < count; index++) hash += `/${user.name[index]}`;
  return `${path}${hash}/${user.name}`;
}

function mailStatus(pamh: PamHandle<LinuxPamHost>, options: MailOptions, folder: string): number {
  const stat = pamh.host.files.stat(folder);
  if (stat === null) return 0;
  if (stat.directory) {
    const fresh = pamh.host.files.listDirectory(`${folder}/new`) ?? [];
    if (fresh.length > 0) return HAVE_NEW_MAIL;
    const current = pamh.host.files.listDirectory(`${folder}/cur`) ?? [];
    if (current.length > 0) return HAVE_OLD_MAIL;
    return options.emptyToo ? HAVE_NO_MAIL : 0;
  }
  if (stat.size > 0) {
    if (stat.accessTime < stat.modifyTime) return HAVE_NEW_MAIL;
    return options.standard ? HAVE_MAIL : HAVE_OLD_MAIL;
  }
  return options.emptyToo ? HAVE_NO_MAIL : 0;
}

function* reportMail(pamh: PamHandle<LinuxPamHost>, options: MailOptions, type: number, folder: string): PamConversationFlow<void> {
  if (options.silent || (options.quiet && type !== HAVE_NEW_MAIL)) return;
  const adjective = type === HAVE_NO_MAIL ? 'no' : type === HAVE_NEW_MAIL ? 'new' : type === HAVE_OLD_MAIL ? 'old' : null;
  const subject = adjective === null ? 'You have mail' : `You have ${adjective} mail`;
  yield* pamh.notify('info', options.standard ? `${subject}.` : `${subject} in folder ${folder}.`);
}

function* doMail(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[], establish: boolean): PamConversationFlow<number> {
  const options = parseOptions(pamh, flags, args);
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) {
    pamh.syslog('notice', `cannot determine user name: ${lookup.code}`);
    return PamReturn.USER_UNKNOWN;
  }
  const user = pamh.host.accounts.findUser(lookup.value);
  if (user === null) {
    pamh.syslog('notice', 'user unknown');
    return PamReturn.USER_UNKNOWN;
  }
  const folder = folderOf(pamh, options, user);
  if (folder === null) return PamReturn.SERVICE_ERR;
  if (!options.noEnv && establish) {
    const code = pamh.putenv(`${MAIL_ENV_NAME}=${folder}`);
    if (code !== PamReturn.SUCCESS) {
      pamh.syslog('crit', `unable to set ${MAIL_ENV_NAME} variable`);
      return PamReturn.BUF_ERR;
    }
  }
  if ((establish && !options.noLogin) || (!establish && options.logoutToo)) {
    const type = mailStatus(pamh, options, folder);
    if (type !== 0) yield* reportMail(pamh, options, type, folder);
  }
  if (!establish && !options.noEnv) pamh.putenv(MAIL_ENV_NAME);
  return PamReturn.SUCCESS;
}

export const pamMailModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: () => PamReturn.IGNORE,
  setcred: (pamh, flags, args) => {
    if ((flags & (PamFlag.ESTABLISH_CRED | PamFlag.DELETE_CRED)) === 0) return PamReturn.IGNORE;
    return doMail(pamh, flags, args, (flags & PamFlag.ESTABLISH_CRED) !== 0);
  },
  openSession: (pamh, flags, args) => doMail(pamh, flags, args, true),
  closeSession: (pamh, flags, args) => doMail(pamh, flags, args, false),
};
