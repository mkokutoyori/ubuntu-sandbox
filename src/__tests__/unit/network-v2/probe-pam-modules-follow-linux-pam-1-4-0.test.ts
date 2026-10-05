/**
 * Sonde — les modules PAM portes (`devices/linux/pam/modules/`) suivent leurs sources dans
 * Linux-PAM 1.4.0 : pam_unix (auth, account, session, chauthtok), pam_deny, pam_permit,
 * pam_rootok, pam_nologin, pam_faillock, pam_wheel, pam_succeed_if, pam_listfile.
 *
 * Mesure de depart : aucun de ces comportements n'existait en tant que module. Le refus
 * « mot de passe faux » etait un `false` de LinuxUserManager.checkPassword ; le verrouillage
 * s'y melangeait ; le journal n'avait pas les lignes `pam_unix(...): authentication failure;
 * logname=... uid=... euid=... tty=... ruser=... rhost=...  user=...` (deux espaces avant `user=`,
 * comme le source) ; l'expiration d'un compte ou d'un mot de passe n'etait qu'un booleen. Il n'y
 * a pas de base a laquelle rejouer la sonde (module neuf, `git stash` ne retire rien : chaque cas
 * tombe sur l'import) ; le TEMOIN (« pam_unix accepte le bon mot de passe ») prouve le labo, et
 * chaque vecteur est derive du source (modules/*.c, tag v1.4.0, lus hors depot).
 *
 * Le code retourne par un module est lu tel quel par une pile `[success=ok ignore=ok default=die]`,
 * dont le statut est le code du module (libpam/pam_dispatch.c : `die` rend `retval`, `ok` aussi).
 *
 * Limites assumees : le fichier de compteur de pam_faillock est du texte (`temps statut source`)
 * et non les enregistrements de 64 octets du source ; le hachage (`yescrypt`) n'est pas modelise,
 * la comparaison passe par le port de comptes ; `crypt_checksalt` (mot de passe a methode
 * obsolete -> NEW_AUTHTOK_REQD) n'a pas d'objet.
 */
import { describe, it, expect } from 'vitest';
import { PamReturn } from '@/network/devices/linux/pam/PamReturnCode';
import { DAY_MS, PamLab, recording, runPamSync, type LabUser } from './pamLab';

const RAW = '[success=ok ignore=ok default=die]';

const ALICE: LabUser = { name: 'alice', uid: 1000, gid: 1000, password: 'secret' };
const ROOT: LabUser = { name: 'root', uid: 0, gid: 0, password: 'rootpw' };
const BOB: LabUser = { name: 'bob', uid: 1001, gid: 1001, password: 'bobpw' };

function service(lines: string[]): Record<string, string> {
  return { '/etc/pam.d/svc': `${lines.join('\n')}\n` };
}

function prepared(lab: PamLab, user = 'alice') {
  const transaction = lab.transaction('svc');
  transaction.handle.user = user;
  transaction.handle.tty = 'ssh';
  transaction.handle.rhost = '10.0.0.1';
  return transaction;
}

function raw(
  type: 'auth' | 'account' | 'session' | 'password', line: string, lab: PamLab, options: { user?: string | null; answers?: Array<string | null> } = {},
) {
  lab.files.set('/etc/pam.d/svc', `${type} ${RAW} ${line}\n`);
  const transaction = lab.transaction('svc');
  if (options.user !== null) transaction.handle.user = options.user ?? 'alice';
  transaction.handle.tty = 'ssh';
  transaction.handle.rhost = '10.0.0.1';
  const conversation = recording(options.answers ?? []);
  const flow = type === 'auth' ? transaction.authenticate()
    : type === 'account' ? transaction.acctMgmt()
      : type === 'session' ? transaction.openSession()
        : transaction.chauthtok();
  return { code: runPamSync(flow, conversation.converse), conversation, transaction };
}

describe('pam_unix authentication', () => {
  it('WITNESS -- the right password authenticates', () => {
    const lab = new PamLab({ users: [ALICE], files: service(['auth required pam_unix.so']) });
    const transaction = prepared(lab);
    const conversation = recording(['secret']);
    expect(runPamSync(transaction.authenticate(), conversation.converse)).toBe(PamReturn.SUCCESS);
    expect(conversation.prompts).toEqual(['Password: ']);
  });

  it('a wrong password fails and journals the failure exactly as pam_unix words it', () => {
    const lab = new PamLab({ users: [ALICE], files: service(['auth required pam_unix.so']) });
    const transaction = prepared(lab);
    expect(runPamSync(transaction.authenticate(), recording(['wrong']).converse)).toBe(PamReturn.AUTH_ERR);
    expect(lab.messages()).toContain(
      'pam_unix(svc:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=10.0.0.1  user=alice');
    expect(lab.logs.at(-1)?.priority).toBe('notice');
  });

  it('the third failure inside one transaction is PAM_MAXTRIES, and the count is reported when it ends', () => {
    const lab = new PamLab({ users: [ALICE], files: service(['auth required pam_unix.so']) });
    const transaction = prepared(lab);
    const codes = [1, 2, 3].map(() => runPamSync(transaction.authenticate(), recording(['bad']).converse));
    expect(codes).toEqual([PamReturn.AUTH_ERR, PamReturn.AUTH_ERR, PamReturn.MAXTRIES]);
    expect(lab.messages().filter((line) => line.includes('authentication failure;'))).toHaveLength(1);
    transaction.end();
    expect(lab.messages()).toContain(
      'PAM 2 more authentication failures; logname= uid=0 euid=0 tty=ssh ruser= rhost=10.0.0.1  user=alice');
  });

  it('a success clears the failure record, so nothing is reported at the end', () => {
    const lab = new PamLab({ users: [ALICE], files: service(['auth required pam_unix.so']) });
    const transaction = prepared(lab);
    runPamSync(transaction.authenticate(), recording(['bad']).converse);
    runPamSync(transaction.authenticate(), recording(['secret']).converse);
    transaction.end();
    expect(lab.messages().some((line) => line.includes('more authentication failure'))).toBe(false);
  });

  it('a locked account (hash starting with !) never authenticates', () => {
    const lab = new PamLab({ users: [{ ...ALICE, hash: '!$y$hash' }] });
    expect(raw('auth', 'pam_unix.so', lab, { answers: ['secret'] }).code).toBe(PamReturn.AUTH_ERR);
  });

  it('an empty password needs nullok: with it no prompt is shown, without it the account is refused', () => {
    const lab = new PamLab({ users: [{ ...ALICE, hash: '' }] });
    const withNullok = raw('auth', 'pam_unix.so nullok', lab);
    expect(withNullok.code).toBe(PamReturn.SUCCESS);
    expect(withNullok.conversation.prompts).toEqual([]);
    expect(raw('auth', 'pam_unix.so', lab, { answers: [''] }).code).toBe(PamReturn.AUTH_ERR);
  });

  it('an unknown user is PAM_USER_UNKNOWN, and a name starting with - or + is refused before any lookup', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(raw('auth', 'pam_unix.so', lab, { user: 'ghost', answers: ['x'] }).code).toBe(PamReturn.USER_UNKNOWN);
    expect(lab.messages()).toContain('pam_unix(svc:auth): check pass; user unknown');
    expect(lab.messages()).toContain('pam_unix(svc:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=10.0.0.1 ');
    expect(raw('auth', 'pam_unix.so', lab, { user: '-rf', answers: ['x'] }).code).toBe(PamReturn.USER_UNKNOWN);
    expect(lab.messages()).toContain('pam_unix(svc:auth): bad username [-rf]');
  });

  it('with no user in the handle it asks "login: " through the conversation', () => {
    const lab = new PamLab({ users: [ALICE] });
    const result = raw('auth', 'pam_unix.so', lab, { user: null, answers: ['alice', 'secret'] });
    expect(result.code).toBe(PamReturn.SUCCESS);
    expect(result.conversation.prompts).toEqual(['login: ', 'Password: ']);
  });

  it('use_first_pass never prompts: without a token already set it fails', () => {
    const lab = new PamLab({ users: [ALICE] });
    const result = raw('auth', 'pam_unix.so use_first_pass', lab, { answers: ['secret'] });
    expect(result.code).toBe(PamReturn.AUTH_ERR);
    expect(result.conversation.prompts).toEqual([]);
  });

  it('a token set by an earlier module is reused without a second prompt', () => {
    const lab = new PamLab({ users: [ALICE], files: service(['auth required pam_unix.so', 'auth required pam_unix.so use_first_pass']) });
    const conversation = recording(['secret']);
    expect(runPamSync(prepared(lab).authenticate(), conversation.converse)).toBe(PamReturn.SUCCESS);
    expect(conversation.prompts).toEqual(['Password: ']);
  });

  it('an unrecognised argument is logged', () => {
    const lab = new PamLab({ users: [ALICE] });
    raw('auth', 'pam_unix.so frobnicate', lab, { answers: ['secret'] });
    expect(lab.messages()).toContain('pam_unix(svc:auth): unrecognized option [frobnicate]');
  });
});

describe('pam_unix account management (check_shadow_expiry)', () => {
  const today = Math.floor(1_700_000_000_000 / DAY_MS);
  const account = (shadow: Partial<NonNullable<LabUser['shadow']>>) =>
    new PamLab({ users: [{ ...ALICE, shadow }] });

  it('an account whose expiry date has passed is PAM_ACCT_EXPIRED, with the message', () => {
    const lab = account({ expire: today - 1 });
    const result = raw('account', 'pam_unix.so', lab);
    expect(result.code).toBe(PamReturn.ACCT_EXPIRED);
    expect(result.conversation.shown).toEqual([{ style: 'error', text: 'Your account has expired; please contact your system administrator.' }]);
    expect(lab.messages()).toContain('pam_unix(svc:account): account alice has expired (account expired)');
  });

  it('a password changed on day 0 is "administrator enforced"', () => {
    const lab = account({ lastChange: 0 });
    const result = raw('account', 'pam_unix.so', lab);
    expect(result.code).toBe(PamReturn.NEW_AUTHTOK_REQD);
    expect(result.conversation.shown[0].text).toBe('You are required to change your password immediately (administrator enforced).');
  });

  it('an aged password is "password expired"', () => {
    const lab = account({ lastChange: today - 100, max: 90 });
    const result = raw('account', 'pam_unix.so', lab);
    expect(result.code).toBe(PamReturn.NEW_AUTHTOK_REQD);
    expect(result.conversation.shown[0].text).toBe('You are required to change your password immediately (password expired).');
  });

  it('past max and the inactivity period the token is expired for good', () => {
    const lab = account({ lastChange: today - 100, max: 30, inactive: 10 });
    expect(raw('account', 'pam_unix.so', lab).code).toBe(PamReturn.AUTHTOK_EXPIRED);
  });

  it('inside the warning window it succeeds and says how many days are left', () => {
    const lab = account({ lastChange: today - 85, max: 90, warn: 7 });
    const result = raw('account', 'pam_unix.so', lab);
    expect(result.code).toBe(PamReturn.SUCCESS);
    expect(result.conversation.shown).toEqual([{ style: 'info', text: 'Warning: your password will expire in 5 days.' }]);
  });

  it('one day left is singular', () => {
    const lab = account({ lastChange: today - 89, max: 90, warn: 7 });
    expect(raw('account', 'pam_unix.so', lab).conversation.shown[0].text).toBe('Warning: your password will expire in 1 day.');
  });

  it('a change too recent (min) is not an account failure', () => {
    const lab = account({ lastChange: today - 1, min: 5 });
    expect(raw('account', 'pam_unix.so', lab).code).toBe(PamReturn.SUCCESS);
  });

  it('quiet keeps the messages back but not the verdict', () => {
    const lab = account({ lastChange: 0 });
    const result = raw('account', 'pam_unix.so quiet', lab);
    expect(result.code).toBe(PamReturn.NEW_AUTHTOK_REQD);
    expect(result.conversation.shown).toEqual([]);
  });

  it('an unknown user is PAM_USER_UNKNOWN', () => {
    expect(raw('account', 'pam_unix.so', new PamLab({ users: [ALICE] }), { user: 'ghost' }).code).toBe(PamReturn.USER_UNKNOWN);
  });
});

describe('pam_unix sessions', () => {
  it('opening a session is journaled with the uid and the invoking login', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 0 } });
    raw('session', 'pam_unix.so', lab);
    expect(lab.messages()).toContain('pam_unix(svc:session): session opened for user alice(uid=1000) by (uid=0)');
  });

  it('the invoking login name appears when there is one', () => {
    const lab = new PamLab({ users: [ALICE, BOB], caller: { uid: 1001, loginName: 'bob' } });
    raw('session', 'pam_unix.so', lab);
    expect(lab.messages()).toContain('pam_unix(svc:session): session opened for user alice(uid=1000) by bob(uid=1001)');
  });

  it('quiet writes nothing, and closing says so', () => {
    const lab = new PamLab({ users: [ALICE] });
    raw('session', 'pam_unix.so quiet', lab);
    expect(lab.messages()).toEqual([]);
    lab.files.set('/etc/pam.d/svc', `session ${RAW} pam_unix.so\n`);
    const transaction = prepared(lab);
    runPamSync(transaction.closeSession(), recording().converse);
    expect(lab.messages()).toContain('pam_unix(svc:session): session closed for user alice');
  });

  it('no user is a session error', () => {
    expect(raw('session', 'pam_unix.so', new PamLab({ users: [ALICE] }), { user: null }).code).toBe(PamReturn.SESSION_ERR);
  });
});

describe('pam_unix password change', () => {
  const stack = (lab: PamLab, line = 'pam_unix.so') => {
    lab.files.set('/etc/pam.d/svc', `password required ${line}\n`);
  };

  it('root changes another user\'s password without being asked for the old one', () => {
    const lab = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    stack(lab);
    const conversation = recording(['newpass', 'newpass']);
    expect(runPamSync(prepared(lab).chauthtok(), conversation.converse)).toBe(PamReturn.SUCCESS);
    expect(conversation.prompts).toEqual(['New password: ', 'Retype new password: ']);
    expect(lab.passwords.get('alice')).toBe('newpass');
  });

  it('a user changes their own password: Changing password, Current password, New, Retype', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 1000, loginName: 'alice' } });
    stack(lab);
    const conversation = recording(['secret', 'newpass', 'newpass']);
    expect(runPamSync(prepared(lab).chauthtok(), conversation.converse)).toBe(PamReturn.SUCCESS);
    expect(conversation.shown).toEqual([{ style: 'info', text: 'Changing password for alice.' }]);
    expect(conversation.prompts).toEqual(['Current password: ', 'New password: ', 'Retype new password: ']);
    expect(lab.passwords.get('alice')).toBe('newpass');
  });

  it('a wrong current password stops the change before anything is asked', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 1000, loginName: 'alice' } });
    stack(lab);
    const conversation = recording(['wrong', 'newpass', 'newpass']);
    expect(runPamSync(prepared(lab).chauthtok(), conversation.converse)).toBe(PamReturn.AUTH_ERR);
    expect(conversation.prompts).toEqual(['Current password: ']);
    expect(lab.passwords.get('alice')).toBe('secret');
  });

  it('retyping a different password is PAM_TRY_AGAIN with the libpam message', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 0 } });
    stack(lab);
    const conversation = recording(['one', 'two']);
    expect(runPamSync(prepared(lab).chauthtok(), conversation.converse)).toBe(PamReturn.TRY_AGAIN);
    expect(conversation.shown).toContainEqual({ style: 'error', text: 'Sorry, passwords do not match.' });
    expect(lab.passwords.get('alice')).toBe('secret');
  });

  it('the same password is refused: "The password has not been changed."', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 1000, loginName: 'alice' } });
    stack(lab);
    const conversation = recording(['secret', 'secret', 'secret']);
    expect(runPamSync(prepared(lab).chauthtok(), conversation.converse)).toBe(PamReturn.AUTHTOK_ERR);
    expect(conversation.shown).toContainEqual({ style: 'error', text: 'The password has not been changed.' });
    expect(lab.passwords.get('alice')).toBe('secret');
  });

  it('minlen refuses a short password for an ordinary user and not for root', () => {
    const user = new PamLab({ users: [ALICE], caller: { uid: 1000, loginName: 'alice' } });
    stack(user, 'pam_unix.so minlen=8');
    const shown = recording(['secret', 'short', 'short']);
    expect(runPamSync(prepared(user).chauthtok(), shown.converse)).toBe(PamReturn.AUTHTOK_ERR);
    expect(shown.shown).toContainEqual({ style: 'error', text: 'You must choose a longer password.' });
    expect(user.passwords.get('alice')).toBe('secret');

    const admin = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    stack(admin, 'pam_unix.so minlen=8');
    expect(runPamSync(prepared(admin).chauthtok(), recording(['short', 'short']).converse)).toBe(PamReturn.SUCCESS);
    expect(admin.passwords.get('alice')).toBe('short');
  });

  it('remember= refuses a password the user already had', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 1000, loginName: 'alice' } });
    lab.history.set('alice', ['oldpass']);
    stack(lab, 'pam_unix.so remember=3');
    const shown = recording(['secret', 'oldpass', 'oldpass']);
    expect(runPamSync(prepared(lab).chauthtok(), shown.converse)).toBe(PamReturn.AUTHTOK_ERR);
    expect(shown.shown).toContainEqual({ style: 'error', text: 'Password has been already used. Choose another.' });
  });
});

describe('pam_deny, pam_permit, pam_rootok', () => {
  const lab = () => new PamLab({ users: [ALICE, ROOT] });

  it('pam_deny answers each entry point with its own error', () => {
    expect(raw('auth', 'pam_deny.so', lab()).code).toBe(PamReturn.AUTH_ERR);
    expect(raw('account', 'pam_deny.so', lab()).code).toBe(PamReturn.AUTH_ERR);
    expect(raw('session', 'pam_deny.so', lab()).code).toBe(PamReturn.SESSION_ERR);
    expect(raw('password', 'pam_deny.so', lab()).code).toBe(PamReturn.AUTHTOK_ERR);
  });

  it('pam_permit succeeds everywhere, and asks for the user in authenticate', () => {
    expect(raw('auth', 'pam_permit.so', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('session', 'pam_permit.so', lab()).code).toBe(PamReturn.SUCCESS);
    const asked = raw('auth', 'pam_permit.so', lab(), { user: null, answers: ['alice'] });
    expect(asked.conversation.prompts).toEqual(['login: ']);
  });

  it('pam_rootok succeeds only when the CALLER is uid 0', () => {
    expect(raw('auth', 'pam_rootok.so', new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } })).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_rootok.so', new PamLab({ users: [ALICE, ROOT], caller: { uid: 1000 } })).code).toBe(PamReturn.AUTH_ERR);
  });
});

describe('pam_nologin', () => {
  const nologin = (extra: Record<string, string> = {}) => new PamLab({ users: [ALICE, ROOT], files: { '/etc/nologin': 'System going down\n', ...extra } });

  it('refuses an ordinary user, shows the message as an error, and lets root through with an info message', () => {
    const refused = raw('account', 'pam_nologin.so', nologin());
    expect(refused.code).toBe(PamReturn.AUTH_ERR);
    expect(refused.conversation.shown).toEqual([{ style: 'error', text: 'System going down\n' }]);
    const root = raw('account', 'pam_nologin.so', nologin(), { user: 'root' });
    expect(root.code).toBe(PamReturn.IGNORE);
    expect(root.conversation.shown[0].style).toBe('info');
  });

  it('with no file it ignores, or succeeds with successok', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(raw('account', 'pam_nologin.so', lab).code).toBe(PamReturn.IGNORE);
    expect(raw('account', 'pam_nologin.so successok', lab).code).toBe(PamReturn.SUCCESS);
  });

  it('prefers /var/run/nologin and honours file=', () => {
    const lab = new PamLab({ users: [ALICE], files: { '/var/run/nologin': 'run\n', '/etc/other': 'other\n' } });
    expect(raw('account', 'pam_nologin.so', lab).conversation.shown[0].text).toBe('run\n');
    expect(raw('account', 'pam_nologin.so file=/etc/other', lab).conversation.shown[0].text).toBe('other\n');
  });
});

describe('pam_faillock', () => {
  const STACK = [
    'auth required pam_faillock.so preauth',
    'auth [success=1 default=bad] pam_unix.so',
    'auth [default=die] pam_faillock.so authfail',
    'auth sufficient pam_faillock.so authsucc',
    'account required pam_faillock.so',
  ];

  const attempt = (lab: PamLab, password: string, user = 'alice') => {
    const transaction = prepared(lab, user);
    const conversation = recording([password]);
    const code = runPamSync(transaction.authenticate(), conversation.converse);
    return { code, conversation };
  };

  it('WITNESS -- before any failure the right password authenticates', () => {
    const lab = new PamLab({ users: [ALICE], files: service(STACK) });
    expect(attempt(lab, 'secret').code).toBe(PamReturn.SUCCESS);
  });

  it('three failures lock the account: the right password is then refused with the lock message', () => {
    const lab = new PamLab({ users: [ALICE], files: service(STACK) });
    for (let index = 0; index < 3; index++) expect(attempt(lab, 'bad').code).toBe(PamReturn.AUTH_ERR);
    expect(lab.messages()).toContain('pam_faillock(svc:auth): Consecutive login failures for user alice account temporarily locked');
    const locked = attempt(lab, 'secret');
    expect(locked.code).toBe(PamReturn.AUTH_ERR);
    expect(locked.conversation.shown).toEqual([
      { style: 'info', text: 'The account is locked due to 3 failed logins.' },
      { style: 'info', text: '(10 minutes left to unlock)' },
    ]);
  });

  it('the tally is a file per user under /var/run/faillock with one valid record per failure', () => {
    const lab = new PamLab({ users: [ALICE], files: service(STACK) });
    attempt(lab, 'bad');
    attempt(lab, 'bad');
    const records = (lab.files.get('/var/run/faillock/alice') ?? '').trim().split('\n');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatch(/^\d+ 3 10\.0\.0\.1$/);
  });

  it('after unlock_time the account is usable again and a success empties the tally', () => {
    const lab = new PamLab({ users: [ALICE], files: service(STACK) });
    for (let index = 0; index < 3; index++) attempt(lab, 'bad');
    lab.now += 601_000;
    expect(attempt(lab, 'secret').code).toBe(PamReturn.SUCCESS);
    expect(lab.files.get('/var/run/faillock/alice')).toBe('');
  });

  it('failures older than fail_interval do not count', () => {
    const lab = new PamLab({ users: [ALICE], files: service(STACK) });
    attempt(lab, 'bad');
    attempt(lab, 'bad');
    lab.now += 901_000;
    expect(attempt(lab, 'bad').code).toBe(PamReturn.AUTH_ERR);
    expect(attempt(lab, 'secret').code).toBe(PamReturn.SUCCESS);
  });

  it('a success below the threshold resets the tally', () => {
    const lab = new PamLab({ users: [ALICE], files: service(STACK) });
    attempt(lab, 'bad');
    attempt(lab, 'bad');
    expect(attempt(lab, 'secret').code).toBe(PamReturn.SUCCESS);
    expect(lab.files.get('/var/run/faillock/alice')).toBe('');
  });

  it('root is never locked unless even_deny_root, and then root_unlock_time governs', () => {
    const plain = new PamLab({ users: [ROOT], files: service(STACK) });
    for (let index = 0; index < 5; index++) attempt(plain, 'bad', 'root');
    expect(attempt(plain, 'rootpw', 'root').code).toBe(PamReturn.SUCCESS);

    const strict = new PamLab({
      users: [ROOT],
      files: { ...service(STACK.map((line) => line.replace('pam_faillock.so', 'pam_faillock.so even_deny_root'))) },
    });
    for (let index = 0; index < 3; index++) attempt(strict, 'bad', 'root');
    expect(attempt(strict, 'rootpw', 'root').code).toBe(PamReturn.AUTH_ERR);
  });

  it('faillock.conf is read, and a module argument overrides it', () => {
    const lab = new PamLab({
      users: [ALICE],
      files: { ...service(STACK), '/etc/security/faillock.conf': '# comment\ndeny = 2\nunlock_time = 60  # a minute\n' },
    });
    attempt(lab, 'bad');
    attempt(lab, 'bad');
    const locked = attempt(lab, 'secret');
    expect(locked.code).toBe(PamReturn.AUTH_ERR);
    expect(locked.conversation.shown[0].text).toBe('The account is locked due to 2 failed logins.');
    expect(locked.conversation.shown[1].text).toBe('(1 minutes left to unlock)');
  });

  it('silent keeps the lock message back, and a missing explicit conf= is a service error', () => {
    const quiet = new PamLab({ users: [ALICE], files: service(STACK.map((line) => line.replace('pam_faillock.so', 'pam_faillock.so silent'))) });
    for (let index = 0; index < 3; index++) attempt(quiet, 'bad');
    expect(attempt(quiet, 'secret').conversation.shown).toEqual([]);

    const broken = new PamLab({ users: [ALICE], files: service(['auth required pam_faillock.so preauth conf=/nowhere']) });
    expect(attempt(broken, 'x').code).toBe(PamReturn.SERVICE_ERR);
    expect(broken.messages()).toContain('pam_faillock(svc:auth): Configuration file missing or broken');
  });

  it('the account stack resets the tally', () => {
    const lab = new PamLab({ users: [ALICE], files: { ...service(STACK), '/var/run/faillock/alice': '1700000000 3 10.0.0.1\n' } });
    const transaction = prepared(lab);
    expect(runPamSync(transaction.acctMgmt(), recording().converse)).toBe(PamReturn.SUCCESS);
    expect(lab.files.get('/var/run/faillock/alice')).toBe('');
  });

  it('an unknown user is ignored by the module (the stack decides)', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(raw('auth', 'pam_faillock.so preauth', lab, { user: 'ghost' }).code).toBe(PamReturn.IGNORE);
    expect(lab.messages()).toContain('pam_faillock(svc:auth): User unknown');
  });
});

describe('pam_wheel', () => {
  const lab = (caller: string) => new PamLab({
    users: [ROOT, ALICE, BOB],
    groups: [{ name: 'wheel', gid: 10, members: ['alice'] }, { name: 'root', gid: 0, members: [] }],
    caller: { uid: caller === 'alice' ? 1000 : 1001, loginName: caller },
  });

  it('a member is ignored by default, a trusted member succeeds, a stranger is denied', () => {
    expect(raw('auth', 'pam_wheel.so', lab('alice'), { user: 'root' }).code).toBe(PamReturn.IGNORE);
    expect(raw('auth', 'pam_wheel.so trust', lab('alice'), { user: 'root' }).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_wheel.so', lab('bob'), { user: 'root' }).code).toBe(PamReturn.PERM_DENIED);
  });

  it('deny turns the sense round', () => {
    expect(raw('auth', 'pam_wheel.so deny', lab('alice'), { user: 'root' }).code).toBe(PamReturn.PERM_DENIED);
    expect(raw('auth', 'pam_wheel.so deny', lab('bob'), { user: 'root' }).code).toBe(PamReturn.IGNORE);
    expect(raw('auth', 'pam_wheel.so deny trust', lab('bob'), { user: 'root' }).code).toBe(PamReturn.SUCCESS);
  });

  it('root_only ignores a target that is not uid 0, and group= picks another group', () => {
    expect(raw('auth', 'pam_wheel.so root_only', lab('bob'), { user: 'alice' }).code).toBe(PamReturn.IGNORE);
    const other = new PamLab({
      users: [ROOT, ALICE, BOB],
      groups: [{ name: 'admins', gid: 50, members: ['bob'] }],
      caller: { uid: 1001, loginName: 'bob' },
    });
    expect(raw('auth', 'pam_wheel.so group=admins trust', other, { user: 'root' }).code).toBe(PamReturn.SUCCESS);
  });

  it('use_uid reads the caller from the uid, not the login name', () => {
    const byUid = new PamLab({
      users: [ROOT, ALICE],
      groups: [{ name: 'wheel', gid: 10, members: ['alice'] }],
      caller: { uid: 1000, loginName: '' },
    });
    expect(raw('auth', 'pam_wheel.so trust use_uid', byUid, { user: 'root' }).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_wheel.so trust', byUid, { user: 'root' }).code).toBe(PamReturn.SERVICE_ERR);
  });

  it('a missing group denies, or is ignored under deny', () => {
    const none = new PamLab({ users: [ROOT, ALICE], caller: { uid: 1000, loginName: 'alice' } });
    expect(raw('auth', 'pam_wheel.so group=ghosts', none, { user: 'root' }).code).toBe(PamReturn.AUTH_ERR);
    expect(raw('auth', 'pam_wheel.so group=ghosts deny', none, { user: 'root' }).code).toBe(PamReturn.IGNORE);
  });
});

describe('pam_succeed_if', () => {
  const lab = () => new PamLab({
    users: [ALICE, { ...ROOT }],
    groups: [{ name: 'staff', gid: 50, members: ['alice'] }],
    caller: { uid: 1000, loginName: 'alice' },
  });

  it('numeric and string comparisons on the user attributes', () => {
    expect(raw('auth', 'pam_succeed_if.so uid >= 1000', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so uid < 1000', lab()).code).toBe(PamReturn.AUTH_ERR);
    expect(raw('auth', 'pam_succeed_if.so user = alice', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so shell != /bin/false', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so uid eq 1000', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so uid ne 1000', lab()).code).toBe(PamReturn.AUTH_ERR);
  });

  it('globs, lists and groups', () => {
    expect(raw('auth', 'pam_succeed_if.so user =~ al*', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so user !~ al*', lab()).code).toBe(PamReturn.AUTH_ERR);
    expect(raw('auth', 'pam_succeed_if.so user in bob:alice:root', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so user notin bob:root', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so user ingroup staff', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so user notingroup staff', lab()).code).toBe(PamReturn.AUTH_ERR);
  });

  it('service, tty and rhost come from the handle', () => {
    expect(raw('auth', 'pam_succeed_if.so service = svc tty = ssh rhost = 10.0.0.1', lab()).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_succeed_if.so service = sshd', lab()).code).toBe(PamReturn.AUTH_ERR);
  });

  it('every condition must hold, and the first failure ends the evaluation with its journal line', () => {
    const l = lab();
    expect(raw('auth', 'pam_succeed_if.so uid >= 1000 user = bob', l).code).toBe(PamReturn.AUTH_ERR);
    expect(l.messages()).toContain('pam_succeed_if(svc:auth): requirement "uid >= 1000" was met by user "alice"');
    expect(l.messages()).toContain('pam_succeed_if(svc:auth): requirement "user = bob" not met by user "alice"');
  });

  it('quiet keeps the journal back; an unknown attribute, a bad number and an incomplete condition are SERVICE_ERR', () => {
    const l = lab();
    raw('auth', 'pam_succeed_if.so quiet uid >= 1000', l);
    expect(l.messages()).toEqual([]);
    expect(raw('auth', 'pam_succeed_if.so colour = red', lab()).code).toBe(PamReturn.SERVICE_ERR);
    expect(raw('auth', 'pam_succeed_if.so uid > many', lab()).code).toBe(PamReturn.SERVICE_ERR);
    expect(raw('auth', 'pam_succeed_if.so uid >=', lab()).code).toBe(PamReturn.SERVICE_ERR);
  });

  it('use_uid evaluates the CALLER, and setcred is ignored', () => {
    const l = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    expect(raw('auth', 'pam_succeed_if.so use_uid user = root', l, { user: 'alice' }).code).toBe(PamReturn.SUCCESS);
  });
});

describe('pam_listfile', () => {
  const files = { '/etc/denied': 'mallory\nbob\n', '/etc/ttys': '/dev/tty1\nssh\n' };
  const lab = (extra: Record<string, string> = {}) => new PamLab({ users: [ALICE, BOB], files: { ...files, ...extra } });

  it('sense=deny refuses a listed user and lets the others through', () => {
    expect(raw('auth', 'pam_listfile.so item=user sense=deny file=/etc/denied onerr=succeed', lab(), { user: 'bob' }).code).toBe(PamReturn.AUTH_ERR);
    expect(raw('auth', 'pam_listfile.so item=user sense=deny file=/etc/denied onerr=succeed', lab()).code).toBe(PamReturn.SUCCESS);
  });

  it('sense=allow admits only the listed', () => {
    expect(raw('auth', 'pam_listfile.so item=user sense=allow file=/etc/denied', lab(), { user: 'bob' }).code).toBe(PamReturn.SUCCESS);
    expect(raw('auth', 'pam_listfile.so item=user sense=allow file=/etc/denied', lab()).code).toBe(PamReturn.AUTH_ERR);
  });

  it('tty names lose their /dev/ on both sides', () => {
    expect(raw('auth', 'pam_listfile.so item=tty sense=allow file=/etc/ttys', lab()).code).toBe(PamReturn.SUCCESS);
  });

  it('a missing file is onerr: SERVICE_ERR by default, SUCCESS with onerr=succeed', () => {
    expect(raw('auth', 'pam_listfile.so item=user sense=deny file=/etc/none', lab()).code).toBe(PamReturn.SERVICE_ERR);
    expect(raw('auth', 'pam_listfile.so item=user sense=deny file=/etc/none onerr=succeed', lab()).code).toBe(PamReturn.SUCCESS);
  });

  it('apply= limits the check to one user, and a missing item or sense is an error', () => {
    expect(raw('auth', 'pam_listfile.so item=tty sense=deny file=/etc/ttys apply=bob', lab()).code).toBe(PamReturn.IGNORE);
    expect(raw('auth', 'pam_listfile.so sense=deny file=/etc/denied', lab()).code).toBe(PamReturn.SERVICE_ERR);
    expect(raw('auth', 'pam_listfile.so item=user file=/etc/denied', lab()).code).toBe(PamReturn.SERVICE_ERR);
  });
});
