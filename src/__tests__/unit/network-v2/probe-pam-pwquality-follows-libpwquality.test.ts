/**
 * Sonde — la verification de qualite des mots de passe suit libpwquality 1.4.4 (src/check.c,
 * src/settings.c, src/error.c, pam_pwquality.c) : ordre des controles (le premier qui echoue est
 * le verdict), credits (dcredit... : un credit positif REDUIT la longueur exigee, un credit negatif
 * exige un minimum), la distance « difok » de check.c, les mots interdits, le score, et le module
 * pam_pwquality (retry, enforce_for_root, fichier /etc/security/pwquality.conf + arguments).
 *
 * Mesure de depart (PasswordQualityPolicy avant le portage) :
 *  - les credits valaient 1 par defaut (libpwquality : 0), de sorte que « abcdef1 » (7 octets) etait
 *    accepte sous un minlen de 8 ;
 *  - le message de longueur disait toujours minlen (« shorter than 8 ») alors que check.c rend la
 *    longueur residuelle apres credits (`size`) ;
 *  - un mot de passe identique a l'ancien etait classe « trop semblable », il a son propre code ;
 *  - « case changes only » et « rotated » n'existaient pas ; la distance etait un nombre de
 *    caracteres differents positionnels, pas la distance de check.c ;
 *  - local_users_only valait true par defaut (libpwquality : 0) ;
 *  - le champ GECOS etait decoupe sur espaces ET virgules (check.c : espaces seulement, donc
 *    `Carpenter,Room` est un seul mot) -- le test existant encodait cette fausse premisse, corrige ;
 *  - tous les controles etaient rapportes ; check.c s'arrete au premier.
 * Cas qui passent des deux cotes (temoins/non-regression) : « un mot de passe fort est accepte »,
 * « mot de passe vide ».
 *
 * Limites : cracklib n'est pas porte, le dictionnaire reste la petite liste du modele
 * (`dictionaryWords`) et son message est celui de cracklib pour un mot de dictionnaire.
 */
import { describe, it, expect } from 'vitest';
import { PasswordQualityPolicy } from '@/network/devices/linux/iam/policy/PasswordQualityPolicy';
import { PasswordQualityRule } from '@/network/devices/linux/iam/policy/PasswordQualityResult';
import { pwqualityCheck } from '@/network/devices/linux/iam/policy/LibPwquality';
import { readPwqualityConfig } from '@/network/devices/linux/iam/policy/PwqualityConfig';
import { PamReturn } from '@/network/devices/linux/pam/PamReturnCode';
import { PamLab, recording, runPamSync, type LabUser } from './pamLab';

const check = (init: ConstructorParameters<typeof PasswordQualityPolicy>[0], password: string, extra: { old?: string; user?: string; gecos?: string } = {}) =>
  pwqualityCheck(new PasswordQualityPolicy(init), password, extra.old ?? null, extra.user ?? null, extra.gecos ?? null);

const message = (verdict: ReturnType<typeof check>): string | null => ('failure' in verdict ? verdict.failure.message : null);
const rule = (verdict: ReturnType<typeof check>): PasswordQualityRule | null => ('failure' in verdict ? verdict.failure.rule : null);

describe('libpwquality check order and messages', () => {
  it('WITNESS -- a strong password is accepted, an empty one is refused', () => {
    expect(check({}, 'Tr0ub4dor&3x').ok).toBe(true);
    expect(message(check({}, ''))).toBe('No password supplied');
  });

  it('default credits are 0: a 7-byte password fails minlen 8, and one credit shortens the requirement', () => {
    expect(message(check({}, 'abcdef1'))).toBe('The password is shorter than 8 characters');
    expect(message(check({ digitCredit: 1 }, 'abcdef1'))).toBeNull();
    expect(message(check({ digitCredit: 1 }, 'abc1'))).toBe('The password is shorter than 7 characters');
  });

  it('credits count each class once per credit, and a negative credit is a class minimum', () => {
    expect(message(check({ digitCredit: 1, minLength: 10 }, 'abcdefgh12'))).toBeNull();
    expect(message(check({ digitCredit: 1, minLength: 12 }, 'abcdefgh12'))).toBe('The password is shorter than 11 characters');
    expect(message(check({ digitCredit: -2 }, 'abcdefgh1'))).toBe('The password contains less than 2 digits');
    expect(message(check({ uppercaseCredit: -1 }, 'abcdefgh1'))).toBe('The password contains less than 1 uppercase letters');
    expect(message(check({ lowercaseCredit: -1 }, 'ABCDEFGH1'))).toBe('The password contains less than 1 lowercase letters');
    expect(message(check({ otherCredit: -1 }, 'abcdefgh1'))).toBe('The password contains less than 1 non-alphanumeric characters');
  });

  it('a palindrome is refused before anything else, case-folded', () => {
    expect(message(check({}, 'abcDCba'))).toBe('The password is a palindrome');
  });

  it('the same password, a case-only change, a too-similar one and a rotated one are four different verdicts', () => {
    expect(message(check({}, 'password1X', { old: 'password1X' }))).toBe('The password is the same as the old one');
    expect(message(check({}, 'PASSword1X', { old: 'password1x' }))).toBe('The password differs with case changes only');
    expect(message(check({ difOk: 4 }, 'abcdefgX', { old: 'abcdefgh' }))).toBe('The password is too similar to the old one');
    expect(message(check({}, '1abcdefg', { old: 'abcdefg1' }))).toBe('The password is just rotated old one');
  });

  it('difok 0 disables the comparison with the old password (but not the identical check)', () => {
    expect(message(check({ difOk: 0 }, 'CORR3ctHorse', { old: 'corr3cthorse' }))).toBeNull();
    expect(message(check({ difOk: 0 }, 'corr3ctHorse', { old: 'corr3ctHorse' }))).toBe('The password is the same as the old one');
  });

  it('a new password at least twice as long as the old one is never "too similar"', () => {
    expect(message(check({ difOk: 9 }, 'abXdefghijkl', { old: 'abcdef' }))).toBeNull();
  });

  it('minclass, maxrepeat, maxclassrepeat and maxsequence', () => {
    expect(message(check({ minClasses: 3 }, 'abcdefgh'))).toBe('The password contains less than 3 character classes');
    expect(message(check({ maxRepeat: 2 }, 'aaabcdef'))).toBe('The password contains more than 2 same characters consecutively');
    expect(message(check({ maxClassRepeat: 3 }, 'abcdXY12'))).toBe('The password contains more than 3 characters of the same class consecutively');
    expect(message(check({ maxClassRepeat: 1 }, 'abcdefgh'))).toBeNull();
    expect(message(check({ maxSequence: 3 }, 'abcdefgh'))).toBe('The password contains monotonic sequence longer than 3 characters');
    expect(message(check({ maxSequence: 3 }, '87654xyz'))).toBe('The password contains monotonic sequence longer than 3 characters');
    expect(message(check({ maxSequence: 3 }, 'abxcdyef'))).toBeNull();
  });

  it('usercheck: the name forwards and reversed, case-folded, only from 4 characters, usersubstr by pieces', () => {
    expect(message(check({}, 'xxAliceyyy', { user: 'alice' }))).toBe('The password contains the user name in some form');
    expect(message(check({}, 'xxecilayyy', { user: 'alice' }))).toBe('The password contains the user name in some form');
    expect(message(check({}, 'xxbobyyyyy', { user: 'bob' }))).toBeNull();
    expect(message(check({}, 'xxalexyyyy', { user: 'alexander' }))).toBeNull();
    expect(message(check({ userSubstr: 4 }, 'xxalexyyyy', { user: 'alexander' }))).toBe('The password contains the user name in some form');
    expect(message(check({ userCheck: false }, 'xxAliceyyy', { user: 'alice' }))).toBeNull();
  });

  it('gecoscheck splits the GECOS field on spaces only, and needs a user', () => {
    expect(message(check({}, 'xxCarpenterx', { user: 'jc', gecos: 'John Carpenter' }))).toBe('The password contains words from the real name of the user in some form');
    expect(message(check({}, 'xxCarpenterx', { user: 'jc', gecos: 'John Carpenter,Room 4' }))).toBeNull();
    expect(message(check({}, 'xxCarpenterx', { gecos: 'John Carpenter' }))).toBeNull();
    expect(message(check({ gecosCheck: false }, 'xxCarpenterx', { user: 'jc', gecos: 'John Carpenter' }))).toBeNull();
  });

  it('badwords are checked like the user name; the dictionary stand-in comes after', () => {
    expect(message(check({ badWords: ['foobar'] }, 'xxfoobaryy'))).toBe('The password contains forbidden words in some form');
    expect(message(check({ badWords: ['foobar'] }, 'xxraboofyy'))).toBe('The password contains forbidden words in some form');
    expect(rule(check({}, 'password12'))).toBe(PasswordQualityRule.DictionaryWord);
    expect(check({ dictCheck: false }, 'password12').ok).toBe(true);
  });

  it('the first failing check is the verdict', () => {
    expect(message(check({ minClasses: 4, maxRepeat: 1 }, 'ab'))).toBe('The password is shorter than 8 characters');
  });

  it('the score grows with length and variety and stays within 0..100', () => {
    const score = (password: string) => { const verdict = check({}, password); return 'score' in verdict ? verdict.score : -1; };
    expect(score('Tr0ub4dor&3x')).toBeGreaterThan(score('qzkxwmvj'));
    expect(score('Tr0ub4dor&3x')).toBeLessThanOrEqual(100);
    expect(score('qzkxwmvj')).toBeGreaterThanOrEqual(0);
  });
});

describe('pwquality.conf parsing', () => {
  it('reads integers, booleans, bare flags, strings and rejects what it does not know', () => {
    const { init, rejected } = readPwqualityConfig([
      '# comment', 'minlen = 12', 'dcredit=-1', 'enforce_for_root', 'local_users_only = 1', 'gecoscheck = 0',
      'badwords = foo bar', 'frobnicate = 3', 'minlen = many', '',
    ].join('\n'));
    expect(init).toMatchObject({ minLength: 12, digitCredit: -1, enforceForRoot: true, localUsersOnly: true, gecosCheck: false, badWords: ['foo', 'bar'] });
    expect(rejected).toEqual(['frobnicate = 3', 'minlen = many']);
  });
});

describe('pam_pwquality in the Ubuntu common-password stack', () => {
  const STACK = [
    'password requisite pam_pwquality.so retry=3',
    'password [success=1 default=ignore] pam_unix.so obscure use_authtok try_first_pass yescrypt',
    'password requisite pam_deny.so',
    'password required pam_permit.so',
    '',
  ].join('\n');
  const ALICE: LabUser = { name: 'alice', uid: 1000, gid: 1000, password: 'oldSecret1' };
  const ROOT: LabUser = { name: 'root', uid: 0, gid: 0, password: 'rootpw' };

  const run = (lab: PamLab, answers: string[], user = 'alice') => {
    lab.files.set('/etc/pam.d/passwd', STACK);
    const transaction = lab.transaction('passwd');
    transaction.handle.user = user;
    const conversation = recording(answers);
    const code = runPamSync(transaction.chauthtok(), conversation.converse);
    return { code, conversation };
  };
  const own = { uid: 1000, euid: 1000, loginName: 'alice' };

  it('WITNESS -- a good new password goes through the whole stack and is stored', () => {
    const lab = new PamLab({ users: [ALICE], caller: own });
    const { code, conversation } = run(lab, ['oldSecret1', 'Corr3ct-Horse-Battery', 'Corr3ct-Horse-Battery']);
    expect(code).toBe(PamReturn.SUCCESS);
    expect(conversation.prompts).toEqual(['Current password: ', 'New password: ', 'Retype new password: ']);
    expect(lab.passwords.get('alice')).toBe('Corr3ct-Horse-Battery');
  });

  it('a weak password prints BAD PASSWORD and asks again, up to retry times, then PAM_MAXTRIES', () => {
    const lab = new PamLab({ users: [ALICE], caller: own });
    const { code, conversation } = run(lab, ['oldSecret1', 'abc', 'abcd', 'abcde']);
    expect(code).toBe(PamReturn.MAXTRIES);
    expect(conversation.shown.filter((entry) => entry.text.startsWith('BAD PASSWORD')).map((entry) => entry.text)).toEqual([
      'BAD PASSWORD: The password is shorter than 8 characters',
      'BAD PASSWORD: The password is shorter than 8 characters',
      'BAD PASSWORD: The password is shorter than 8 characters',
    ]);
    expect(lab.passwords.get('alice')).toBe('oldSecret1');
  });

  it('the second try can succeed', () => {
    const lab = new PamLab({ users: [ALICE], caller: own });
    const { code } = run(lab, ['oldSecret1', 'abc', 'Corr3ct-Horse-Battery', 'Corr3ct-Horse-Battery']);
    expect(code).toBe(PamReturn.SUCCESS);
    expect(lab.passwords.get('alice')).toBe('Corr3ct-Horse-Battery');
  });

  it('a mistyped retype is TRY_AGAIN for pam_pwquality: it loops and asks for a new password again', () => {
    const lab = new PamLab({ users: [ALICE], caller: own });
    const { code, conversation } = run(lab, ['oldSecret1', 'Corr3ct-Horse-Battery', 'Corr3ct-Horse-Batterz', 'Another-Fine-Passw0rd', 'Another-Fine-Passw0rd']);
    expect(code).toBe(PamReturn.SUCCESS);
    expect(conversation.shown).toContainEqual({ style: 'error', text: 'Sorry, passwords do not match.' });
    expect(lab.passwords.get('alice')).toBe('Another-Fine-Passw0rd');
  });

  it('root is warned but not blocked unless enforce_for_root', () => {
    const lab = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    const { code, conversation } = run(lab, ['abc', 'abc']);
    expect(code).toBe(PamReturn.SUCCESS);
    expect(conversation.shown[0]).toEqual({ style: 'error', text: 'BAD PASSWORD: The password is shorter than 8 characters' });
    expect(lab.passwords.get('alice')).toBe('abc');
    const strict = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 }, files: { '/etc/security/pwquality.conf': 'enforce_for_root\n' } });
    expect(run(strict, ['abc', 'abc', 'abc']).code).toBe(PamReturn.MAXTRIES);
  });

  it('pwquality.conf is read, module arguments override it, enforcing=0 only warns', () => {
    const file = new PamLab({ users: [ALICE], caller: own, files: { '/etc/security/pwquality.conf': 'minlen = 14\n' } });
    expect(run(file, ['oldSecret1', 'Corr3ct-Horse', 'Corr3ct-Horse', 'x', 'x']).code).not.toBe(PamReturn.SUCCESS);
    expect(file.messages().some((line) => line.includes('Reading pwquality'))).toBe(false);
    const overridden = new PamLab({ users: [ALICE], caller: own, files: { '/etc/security/pwquality.conf': 'minlen = 14\n' } });
    overridden.files.set('/etc/pam.d/passwd', 'password requisite pam_pwquality.so minlen=9\npassword required pam_unix.so use_authtok\n');
    const transaction = overridden.transaction('passwd');
    transaction.handle.user = 'alice';
    expect(runPamSync(transaction.chauthtok(), recording(['oldSecret1', 'abcdefgh1', 'abcdefgh1']).converse)).toBe(PamReturn.SUCCESS);
    const soft = new PamLab({ users: [ALICE], caller: own, files: { '/etc/security/pwquality.conf': 'enforcing = 0\n' } });
    const result = run(soft, ['oldSecret1', 'abc', 'abc']);
    expect(result.code).toBe(PamReturn.SUCCESS);
    expect(result.conversation.shown.some((entry) => entry.text.startsWith('BAD PASSWORD'))).toBe(true);
  });

  it('a missing configuration file and an unknown option are journaled', () => {
    const lab = new PamLab({ users: [ALICE], caller: own });
    lab.files.set('/etc/pam.d/passwd', 'password required pam_pwquality.so frobnicate\n');
    const transaction = lab.transaction('passwd');
    transaction.handle.user = 'alice';
    runPamSync(transaction.chauthtok(), recording(['oldSecret1', 'Corr3ct-Horse-Battery', 'Corr3ct-Horse-Battery']).converse);
    expect(lab.messages()).toContain('pam_pwquality(passwd:chauthtok): Reading pwquality configuration file failed: Configuration file not found');
    expect(lab.messages()).toContain('pam_pwquality(passwd:chauthtok): pam_parse: unknown or broken option; frobnicate');
  });
});
