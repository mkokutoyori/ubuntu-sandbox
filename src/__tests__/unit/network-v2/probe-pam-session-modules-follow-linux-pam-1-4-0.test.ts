/**
 * Sonde — les modules de session portes depuis Linux-PAM 1.4.0 : pam_env, pam_umask,
 * pam_loginuid, pam_limits, pam_shells, pam_faildelay, et le delai d'echec de libpam
 * (pam_fail_delay / _pam_await_timer, 2 s par defaut dans pam_unix sauf `nodelay`).
 *
 * Mesure de depart : aucun de ces modules n'existait ; les piles Ubuntu 22.04 semees
 * (sshd, login, su, sudo, cron) les citent en `required`, de sorte qu'une ouverture de session
 * sur ces piles retombait sur PAM_MODULE_UNKNOWN. Chaque cas tombe donc sur « module
 * inconnu » avant le correctif ; temoins verts des deux cotes : « pam_permit ouvre la
 * session » et « pam_unix authentifie le bon mot de passe », qui prouvent le labo.
 *
 * Les etats d'ecriture (umask, rlimits, priorite, loginuid) vivent dans `host.process`,
 * l'etat du processus appelant ; l'environnement dans `handle.environment`.
 *
 * Un commentaire en fin de ligne laisse l'espace qui le precede dans la valeur
 * (`EDITOR=vim # x` donne `EDITOR=vim `) : _assemble_line coupe a `#` sans retirer l'espace, le test le
 * fige parce que c'est le comportement du source.
 *
 * Limites : pam_env lit `~/.pam_environment` avec les droits de root et non ceux de
 * l'utilisateur (pas de pam_modutil_drop_priv) ; pam_limits ne compte les connexions que
 * dans la liste fournie par l'hote (pas de test de PID perime) ; le delai d'echec est
 * rendu a l'appelant (`failDelayUs`), qui l'attend dans le temps virtuel.
 */
import { describe, it, expect } from 'vitest';
import { computeFailDelay } from '@/network/devices/linux/pam/PamTransaction';
import { PamReturn } from '@/network/devices/linux/pam/PamReturnCode';
import { PamLab, recording, runPamSync, type LabUser } from './pamLab';

const ALICE: LabUser = { name: 'alice', uid: 1000, gid: 1000, password: 'secret' };
const BOB: LabUser = { name: 'bob', uid: 1001, gid: 1001, password: 'bobpw' };
const ROOT: LabUser = { name: 'root', uid: 0, gid: 0, password: 'rootpw' };

const RAW = '[success=ok ignore=ok default=die]';

function open(lab: PamLab, line: string, user = 'alice') {
  lab.files.set('/etc/pam.d/svc', `session ${RAW} ${line}\n`);
  const transaction = lab.transaction('svc');
  transaction.handle.user = user;
  const conversation = recording();
  const code = runPamSync(transaction.openSession(), conversation.converse);
  return { code, transaction, conversation };
}

describe('labo', () => {
  it('WITNESS -- pam_permit opens a session and pam_unix authenticates the right password', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(open(lab, 'pam_permit.so').code).toBe(PamReturn.SUCCESS);
    lab.files.set('/etc/pam.d/svc', 'auth required pam_unix.so\n');
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    expect(runPamSync(transaction.authenticate(), recording(['secret']).converse)).toBe(PamReturn.SUCCESS);
  });
});

describe('pam_env', () => {
  const files = (extra: Record<string, string>) => ({ '/etc/security/pam_env.conf': '', '/etc/environment': '', ...extra });

  it('reads /etc/environment: export prefix, quotes, comments, bad keys', () => {
    const lab = new PamLab({
      users: [ALICE],
      files: files({
        '/etc/environment': 'PATH="/usr/local/bin:/usr/bin"\nexport EDITOR=vim # trailing\n# COMMENTED=1\n1BAD KEY=x\n=novalue\nQUOTED=\'single\'\n',
      }),
    });
    const { code, transaction } = open(lab, 'pam_env.so');
    expect(code).toBe(PamReturn.SUCCESS);
    expect(transaction.handle.environmentList()).toEqual(['PATH=/usr/local/bin:/usr/bin', 'EDITOR=vim ', 'QUOTED=single']);
    expect(lab.messages()).toContain('pam_env(svc:session): non-alphanumeric key \'1BAD KEY=x\' in /etc/environment\', ignoring');
    expect(lab.messages()).toContain('pam_env(svc:session): missing key name \'=novalue\' in /etc/environment\', ignoring');
  });

  it('readenv=0 skips /etc/environment, envfile= names another file', () => {
    const lab = new PamLab({ users: [ALICE], files: files({ '/etc/environment': 'A=1\n', '/etc/default/locale': 'LANG=C.UTF-8\n' }) });
    expect(open(lab, 'pam_env.so readenv=0').transaction.handle.environmentList()).toEqual([]);
    expect(open(lab, 'pam_env.so envfile=/etc/default/locale').transaction.handle.environmentList()).toEqual(['LANG=C.UTF-8']);
  });

  it('pam_env.conf: DEFAULT, OVERRIDE, ${VAR} set by an earlier read, @{PAM_ITEM}, @{HOME}, escapes, quoted empty and deletion', () => {
    const lab = new PamLab({
      users: [ALICE],
      files: {
        '/etc/environment': 'TZOVR=Europe/Paris\nGONE=1\n',
        '/etc/security/pam_env.conf': [
          'GREETING DEFAULT=hello',
          'TZ DEFAULT=UTC OVERRIDE=${TZOVR}',
          'WHO DEFAULT=@{PAM_USER}',
          'WHERE DEFAULT=@{PAM_RHOST}:22',
          'HOMEDIR DEFAULT=@{HOME}/work',
          'LITERAL DEFAULT=\\${keep}',
          'EMPTY DEFAULT=""',
          'GONE',
          'BADLINE FOO=bar',
          '',
        ].join('\n'),
      },
    });
    lab.files.set('/etc/security/empty.conf', '');
    lab.files.set('/etc/pam.d/svc', `session ${RAW} pam_env.so conffile=/etc/security/empty.conf\nsession ${RAW} pam_env.so readenv=0\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    transaction.handle.rhost = '10.0.0.7';
    runPamSync(transaction.openSession(), recording().converse);
    const environment = Object.fromEntries(transaction.handle.environment);
    expect(environment).toMatchObject({
      GREETING: 'hello', TZ: 'Europe/Paris', WHO: 'alice', WHERE: '10.0.0.7:22', HOMEDIR: '/home/alice/work', LITERAL: '${keep}', EMPTY: '',
    });
    expect('GONE' in environment).toBe(false);
    expect(lab.messages()).toContain('pam_env(svc:session): Unrecognized Option: FOO=bar - ignoring line');
  });

  it('a missing config file is logged and ignored, an unknown option is logged, user_readenv reads ~/.pam_environment', () => {
    const lab = new PamLab({
      users: [ALICE],
      files: { '/etc/environment': '', '/home/alice/.pam_environment': 'MINE DEFAULT=yes\n' },
    });
    const absent = open(lab, 'pam_env.so frobnicate');
    expect(absent.code).toBe(PamReturn.IGNORE);
    expect(lab.messages()).toContain('pam_env(svc:session): Unable to open config file: /etc/security/pam_env.conf: No such file or directory');
    expect(lab.messages()).toContain('pam_env(svc:session): unknown option: frobnicate');
    lab.files.set('/etc/security/pam_env.conf', '');
    expect(open(lab, 'pam_env.so user_readenv=1').transaction.handle.environmentList()).toEqual(['MINE=yes']);
    expect(open(lab, 'pam_env.so').transaction.handle.environmentList()).toEqual([]);
  });

  it('authenticate is ignored, account and password management are service errors', () => {
    const lab = new PamLab({ users: [ALICE], files: files({}) });
    lab.files.set('/etc/pam.d/svc', `auth ${RAW} pam_env.so\naccount ${RAW} pam_env.so\n`);
    const authenticate = lab.transaction('svc');
    authenticate.handle.user = 'alice';
    expect(runPamSync(authenticate.authenticate(), recording().converse)).toBe(PamReturn.IGNORE);
    const account = lab.transaction('svc');
    account.handle.user = 'alice';
    expect(runPamSync(account.acctMgmt(), recording().converse)).toBe(PamReturn.SERVICE_ERR);
    expect(lab.messages()).toContain('pam_env(svc:account): pam_sm_acct_mgmt called inappropriately');
  });
});

describe('pam_umask', () => {
  it('takes UMASK from /etc/login.defs, then /etc/default/login, and umask= beats both', () => {
    const lab = new PamLab({ users: [ALICE], files: { '/etc/login.defs': '# c\nUMASK\t027\n' } });
    open(lab, 'pam_umask.so');
    expect(lab.process.umask).toBe(0o027);
    open(lab, 'pam_umask.so umask=077');
    expect(lab.process.umask).toBe(0o077);
    const fallback = new PamLab({ users: [ALICE], files: { '/etc/default/login': 'UMASK=037\n' } });
    open(fallback, 'pam_umask.so');
    expect(fallback.process.umask).toBe(0o037);
  });

  it('with no source the umask is left alone', () => {
    const lab = new PamLab({ users: [ALICE] });
    open(lab, 'pam_umask.so');
    expect(lab.process.umask).toBe(0o022);
  });

  it('usergroups copies the owner bits to the group bits for a user whose group bears their name', () => {
    const lab = new PamLab({ users: [ALICE, ROOT], groups: [{ name: 'alice', gid: 1000, members: [] }, { name: 'root', gid: 0, members: [] }], files: { '/etc/login.defs': 'UMASK 022\n' } });
    open(lab, 'pam_umask.so usergroups');
    expect(lab.process.umask).toBe(0o002);
    const admin = new PamLab({ users: [ROOT], groups: [{ name: 'root', gid: 0, members: [] }], files: { '/etc/login.defs': 'UMASK 022\n' } });
    open(admin, 'pam_umask.so usergroups', 'root');
    expect(admin.process.umask).toBe(0o022);
  });

  it('GECOS umask=, pri= and ulimit= are applied; a negative pri needs privilege', () => {
    const gecos = (text: string) => new PamLab({ users: [{ ...ALICE, gecos: text } as LabUser] });
    const lab = gecos('Alice,,,,umask=077,pri=5,ulimit=10');
    open(lab, 'pam_umask.so');
    expect(lab.process.umask).toBe(0o077);
    expect(lab.process.priority).toBe(5);
    expect(lab.process.limits.get('fsize')).toEqual({ soft: 5120, hard: 5120 });

    const denied = new PamLab({ users: [{ ...ALICE, gecos: 'pri=-5' } as LabUser], caller: { uid: 1000 } });
    const result = open(denied, 'pam_umask.so');
    expect(result.code).toBe(PamReturn.SUCCESS);
    expect(denied.process.priority).toBe(0);
    expect(result.conversation.shown).toEqual([{ style: 'error', text: 'nice failed: Operation not permitted\n' }]);
    const quiet = new PamLab({ users: [{ ...ALICE, gecos: 'pri=-5' } as LabUser], caller: { uid: 1000 } });
    expect(open(quiet, 'pam_umask.so silent').conversation.shown).toEqual([]);
    expect(quiet.messages()).toContain('pam_umask(svc:session): nice failed: Operation not permitted');
  });

  it('an unknown user is PAM_USER_UNKNOWN', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(open(lab, 'pam_umask.so', 'ghost').code).toBe(PamReturn.USER_UNKNOWN);
    expect(lab.messages()).toContain('pam_umask(svc:session): account for ghost not found');
  });
});

describe('pam_loginuid', () => {
  it('writes the login uid of the target user into the process', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(open(lab, 'pam_loginuid.so').code).toBe(PamReturn.SUCCESS);
    expect(lab.process.loginUid).toBe(1000);
  });

  it('refuses to overwrite a different login uid without privilege, allows it to root', () => {
    const lab = new PamLab({ users: [ALICE, BOB], caller: { uid: 1000 } });
    lab.process.loginUid = 1001;
    expect(open(lab, 'pam_loginuid.so').code).toBe(PamReturn.SESSION_ERR);
    expect(lab.messages()).toContain('pam_loginuid(svc:session): Error writing /proc/self/loginuid: Operation not permitted');
    const root = new PamLab({ users: [ALICE, BOB], caller: { uid: 0 } });
    root.process.loginUid = 1001;
    expect(open(root, 'pam_loginuid.so').code).toBe(PamReturn.SUCCESS);
    expect(root.process.loginUid).toBe(1000);
  });

  it('require_auditd needs a running auditd; an unknown user is a session error', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(open(lab, 'pam_loginuid.so require_auditd').code).toBe(PamReturn.SESSION_ERR);
    expect(lab.messages()).toContain('pam_loginuid(svc:session): required running auditd not detected');
    lab.auditd = true;
    expect(open(lab, 'pam_loginuid.so require_auditd').code).toBe(PamReturn.SUCCESS);
    expect(open(lab, 'pam_loginuid.so', 'ghost').code).toBe(PamReturn.SESSION_ERR);
  });
});

describe('pam_limits', () => {
  const limits = (text: string, extra: Record<string, string> = {}, options: Partial<ConstructorParameters<typeof PamLab>[0]> = {}) =>
    new PamLab({
      users: [ALICE, BOB, ROOT],
      groups: [{ name: 'staff', gid: 50, members: ['alice'] }],
      files: { '/etc/security/limits.conf': text, ...extra },
      ...options,
    });

  it('a user line beats the * default line for the same item, and units are scaled', () => {
    const lab = limits('* soft nofile 4096\nalice hard nofile 8192\nalice - cpu 2\nalice soft core 10\nalice - fsize 100\n');
    expect(open(lab, 'pam_limits.so').code).toBe(PamReturn.SUCCESS);
    expect(lab.process.limits.get('nofile')).toEqual({ soft: 4096, hard: 8192 });
    expect(lab.process.limits.get('cpu')).toEqual({ soft: 120, hard: 120 });
    expect(lab.process.limits.get('core')).toEqual({ soft: 10240, hard: Number.POSITIVE_INFINITY });
    expect(lab.process.limits.get('fsize')).toEqual({ soft: 102400, hard: 102400 });
  });

  it('the priority of a source decides: USER < GROUP < DEFAULT, and a later equal source overrides', () => {
    const lab = limits('* - nproc 10\n@staff - nproc 20\nalice - nproc 30\nalice - nproc 40\n');
    open(lab, 'pam_limits.so');
    expect(lab.process.limits.get('nproc')).toEqual({ soft: 40, hard: 40 });
    const other = limits('* - nproc 10\n@staff - nproc 20\n');
    open(other, 'pam_limits.so');
    expect(other.process.limits.get('nproc')).toEqual({ soft: 20, hard: 20 });
    const bob = limits('* - nproc 10\n@staff - nproc 20\n');
    open(bob, 'pam_limits.so', 'bob');
    expect(bob.process.limits.get('nproc')).toEqual({ soft: 10, hard: 10 });
  });

  it('unlimited, -1 and infinity, nice and priority', () => {
    const lab = limits('alice - data unlimited\nalice - nice 5\nalice - priority 3\nalice - memlock infinity\n');
    open(lab, 'pam_limits.so');
    expect(lab.process.limits.get('data')).toEqual({ soft: Number.POSITIVE_INFINITY, hard: Number.POSITIVE_INFINITY });
    expect(lab.process.limits.get('nice')).toEqual({ soft: 15, hard: 15 });
    expect(lab.process.priority).toBe(3);
    expect(lab.process.limits.get('memlock')?.soft).toBe(Number.POSITIVE_INFINITY);
  });

  it('a "<domain> -" line means no limits at all and applies nothing from the lines after it', () => {
    const lab = limits('bob -\n* - nofile 100\n');
    expect(open(lab, 'pam_limits.so', 'bob').code).toBe(PamReturn.SUCCESS);
    expect(lab.process.limits.get('nofile')).toEqual({ soft: 1024, hard: 1_048_576 });
    expect(open(lab, 'pam_limits.so').transaction.host.process.limits.get('nofile')?.soft).toBe(100);
  });

  it('uid ranges: :max, min:, min:max and a malformed range is skipped with a warning', () => {
    const lab = limits(':1000 - nofile 111\n1001: - nproc 222\n1000:1001 - core 333\n1x:5 - cpu 9\n');
    open(lab, 'pam_limits.so');
    expect(lab.process.limits.get('nofile')?.soft).toBe(111);
    expect(lab.process.limits.get('nproc')?.soft).toBe(15730);
    expect(lab.process.limits.get('core')?.soft).toBe(333 * 1024);
    expect(lab.messages()).toContain('pam_limits(svc:session): invalid uid range \'1x:5\' - skipped');
  });

  it('limits.d/*.conf follow limits.conf in sorted order, and conf= reads only that file', () => {
    const lab = limits('alice - nofile 100\n', {
      '/etc/security/limits.d/20-b.conf': 'alice - nofile 300\n',
      '/etc/security/limits.d/10-a.conf': 'alice - nofile 200\n',
      '/etc/security/limits.d/skip.txt': 'alice - nofile 999\n',
      '/etc/security/other.conf': 'alice - nofile 5000\n',
    });
    open(lab, 'pam_limits.so');
    expect(lab.process.limits.get('nofile')?.soft).toBe(300);
    const solo = limits('alice - nofile 100\n', { '/etc/security/other.conf': 'alice - nofile 5000\n' });
    open(solo, 'pam_limits.so conf=/etc/security/other.conf');
    expect(solo.process.limits.get('nofile')?.soft).toBe(5000);
    const missing = limits('');
    expect(open(missing, 'pam_limits.so conf=/nope').code).toBe(PamReturn.SERVICE_ERR);
    expect(missing.messages()).toContain('pam_limits(svc:session): cannot read settings from /nope: No such file or directory');
  });

  it('raising a hard limit needs privilege, and nofile cannot pass fs.nr_open even for root', () => {
    const user = limits('alice - nofile 2000000\nalice hard nproc 99999\n', {}, { caller: { uid: 1000 } });
    expect(open(user, 'pam_limits.so').code).toBe(PamReturn.PERM_DENIED);
    expect(user.messages()).toContain('pam_limits(svc:session): Could not set limit for \'nofile\': Operation not permitted');
    const root = limits('alice - nofile 2000000\n', {}, { caller: { uid: 0 } });
    expect(open(root, 'pam_limits.so').code).toBe(PamReturn.PERM_DENIED);
    const allowed = limits('alice hard nproc 99999\n', {}, { caller: { uid: 0 } });
    expect(open(allowed, 'pam_limits.so').code).toBe(PamReturn.SUCCESS);
    expect(allowed.process.limits.get('nproc')?.hard).toBe(99999);
  });

  it('soft above hard is clamped to hard, and a lower hard than the process one is allowed', () => {
    const lab = limits('alice soft nofile 900\nalice hard nofile 500\n', {}, { caller: { uid: 1000 } });
    expect(open(lab, 'pam_limits.so').code).toBe(PamReturn.SUCCESS);
    expect(lab.process.limits.get('nofile')).toEqual({ soft: 500, hard: 500 });
  });

  it('maxlogins counts this session plus the live ones of the same user, root is exempt, 0 forbids', () => {
    const lab = limits('alice - maxlogins 2\n');
    lab.loginList.push({ user: 'alice' }, { user: 'bob' });
    expect(open(lab, 'pam_limits.so').code).toBe(PamReturn.SUCCESS);
    lab.loginList.push({ user: 'alice' });
    const refused = open(lab, 'pam_limits.so');
    expect(refused.code).toBe(PamReturn.PERM_DENIED);
    expect(refused.conversation.shown).toEqual([{ style: 'error', text: 'There were too many logins for \'alice\'.' }]);
    expect(lab.messages()).toContain('pam_limits(svc:session): Too many logins (max 2) for alice');
    expect(open(lab, 'pam_limits.so utmp_early').code).toBe(PamReturn.SUCCESS);
    const none = limits('* - maxlogins 0\n');
    expect(open(none, 'pam_limits.so').code).toBe(PamReturn.PERM_DENIED);
    expect(open(none, 'pam_limits.so', 'root').code).toBe(PamReturn.SUCCESS);
  });

  it('maxsyslogins counts everybody, %group counts the logins of its members', () => {
    const lab = limits('* - maxsyslogins 2\n');
    lab.loginList.push({ user: 'bob' });
    expect(open(lab, 'pam_limits.so', 'bob').code).toBe(PamReturn.SUCCESS);
    lab.loginList.push({ user: 'root' });
    expect(open(lab, 'pam_limits.so', 'bob').code).toBe(PamReturn.PERM_DENIED);
    const group = limits('%staff - maxlogins 1\n');
    group.loginList.push({ user: 'bob' });
    expect(open(group, 'pam_limits.so').code).toBe(PamReturn.SUCCESS);
    group.loginList.push({ user: 'alice' });
    expect(open(group, 'pam_limits.so').code).toBe(PamReturn.PERM_DENIED);
  });

  it('wrong values and unknown items are skipped with a debug line only', () => {
    const lab = limits('alice - nofile many\nalice - colour 3\nalice - nofile 700\nalice frob nofile 1\n');
    expect(open(lab, 'pam_limits.so').code).toBe(PamReturn.SUCCESS);
    expect(lab.process.limits.get('nofile')?.soft).toBe(700);
    expect(lab.messages()).toContain('pam_limits(svc:session): wrong limit value \'many\' for limit type \'-\'');
    expect(lab.messages()).toContain('pam_limits(svc:session): unknown limit item \'colour\'');
    expect(lab.messages()).toContain('pam_limits(svc:session): unknown limit type \'frob\'');
  });

  it('set_all starts from /proc/1/limits and a missing file is a warning', () => {
    const lab = limits('', { '/proc/1/limits': [
      'Limit                     Soft Limit           Hard Limit           Units     ',
      'Max cpu time              unlimited            unlimited            seconds   ',
      'Max open files            1024                 524288               files     ',
      '',
    ].join('\n') });
    open(lab, 'pam_limits.so set_all');
    expect(lab.process.limits.get('nofile')).toEqual({ soft: 1024, hard: 524288 });
    const without = limits('');
    open(without, 'pam_limits.so set_all');
    expect(without.messages()).toContain('pam_limits(svc:session): Could not read /proc/1/limits (No such file or directory), using PAM defaults');
  });
});

describe('pam_shells', () => {
  const lab = (shell: string, extra: Record<string, string> = { '/etc/shells': '# shells\n/bin/sh\n/bin/bash\n' }) =>
    new PamLab({ users: [{ ...ALICE, shell }], files: extra });
  const auth = (labo: PamLab) => {
    labo.files.set('/etc/pam.d/svc', 'auth required pam_shells.so\n');
    const transaction = labo.transaction('svc');
    transaction.handle.user = 'alice';
    return runPamSync(transaction.authenticate(), recording().converse);
  };

  it('accepts a shell listed in /etc/shells and refuses another, an unknown user and a missing file', () => {
    expect(auth(lab('/bin/bash'))).toBe(PamReturn.SUCCESS);
    expect(auth(lab('/usr/sbin/nologin'))).toBe(PamReturn.AUTH_ERR);
    expect(auth(lab('/bin/bash', {}))).toBe(PamReturn.AUTH_ERR);
  });

  it('a world-writable /etc/shells is refused and an empty shell means /bin/sh', () => {
    const writable = lab('/bin/bash');
    writable.modes.set('/etc/shells', 0o666);
    expect(auth(writable)).toBe(PamReturn.AUTH_ERR);
    expect(writable.messages()).toContain('pam_shells(svc:auth): /etc/shells is either world writable or not a normal file');
    expect(auth(lab(''))).toBe(PamReturn.SUCCESS);
  });
});

describe('fail delay', () => {
  const pamUnix = (line: string) => {
    const lab = new PamLab({ users: [ALICE], now: 1_700_000_000_000, files: { '/etc/login.defs': 'FAIL_DELAY 3\n' } });
    lab.files.set('/etc/pam.d/svc', `${line}\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    return { lab, transaction };
  };

  it('pam_unix asks for 2 s on failure: the delay is within +-50% and deterministic from the time', () => {
    const { transaction } = pamUnix('auth required pam_unix.so');
    expect(runPamSync(transaction.authenticate(), recording(['bad']).converse)).toBe(PamReturn.AUTH_ERR);
    expect(transaction.failDelayUs).toBeGreaterThanOrEqual(1_000_000);
    expect(transaction.failDelayUs).toBeLessThanOrEqual(3_000_000);
    expect(transaction.failDelayUs).toBe(computeFailDelay(1_700_000_000, 2_000_000));
  });

  it('success, and nodelay, leave no delay', () => {
    const ok = pamUnix('auth required pam_unix.so');
    expect(runPamSync(ok.transaction.authenticate(), recording(['secret']).converse)).toBe(PamReturn.SUCCESS);
    expect(ok.transaction.failDelayUs).toBe(0);
    const none = pamUnix('auth required pam_unix.so nodelay');
    expect(runPamSync(none.transaction.authenticate(), recording(['bad']).converse)).toBe(PamReturn.AUTH_ERR);
    expect(none.transaction.failDelayUs).toBe(0);
  });

  it('pam_faildelay: the largest request wins, delay= is microseconds, FAIL_DELAY in login.defs is seconds', () => {
    const explicit = pamUnix('auth optional pam_faildelay.so delay=5000000\nauth required pam_unix.so');
    runPamSync(explicit.transaction.authenticate(), recording(['bad']).converse);
    expect(explicit.transaction.failDelayUs).toBe(computeFailDelay(1_700_000_000, 5_000_000));
    const configured = pamUnix('auth optional pam_faildelay.so\nauth required pam_unix.so nodelay');
    runPamSync(configured.transaction.authenticate(), recording(['bad']).converse);
    expect(configured.transaction.failDelayUs).toBe(computeFailDelay(1_700_000_000, 3_000_000));
    const smaller = pamUnix('auth optional pam_faildelay.so delay=100\nauth required pam_unix.so');
    runPamSync(smaller.transaction.authenticate(), recording(['bad']).converse);
    expect(smaller.transaction.failDelayUs).toBe(computeFailDelay(1_700_000_000, 2_000_000));
  });

  it('the same seed gives the same delay and another second gives another', () => {
    expect(computeFailDelay(1, 2_000_000)).toBe(computeFailDelay(1, 2_000_000));
    expect(computeFailDelay(1, 2_000_000)).not.toBe(computeFailDelay(2, 2_000_000));
  });
});
