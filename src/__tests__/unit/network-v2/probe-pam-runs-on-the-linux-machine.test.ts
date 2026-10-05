/**
 * Sonde — la pile PAM tourne sur la MACHINE : `/etc/pam.d/*` de l'Ubuntu 22.04 est semee dans
 * son VFS, le module pam_unix lit les vrais comptes (LinuxUserManager), ecrit ses lignes dans
 * `/var/log/auth.log` et le journal sous l'identifiant du service, pam_faillock tient son
 * compteur dans `/var/run/faillock/<user>` du VFS, pam_unix chauthtok change le mot de passe de
 * la base de comptes ET de `/etc/shadow`, et `remember=` s'appuie sur `/etc/security/opasswd`.
 *
 * Mesure de depart : `LinuxUserManager.checkPassword` etait la seule voie d'authentification ;
 * aucune pile n'etait lue, `/etc/pam.d` ne contenait que `common-password`, `getPam()` n'existait
 * pas -- chaque cas tombe sur `getPam is not a function`. TEMOINS (verts avant et apres, car
 * construits dans le meme labo) : « un compte ordinaire existe » et « le bon mot de passe
 * authentifie par checkPassword ».
 *
 * Une expiration de compte rend PAM_AUTH_ERR et non PAM_ACCT_EXPIRED : dans common-account d'Ubuntu
 * `default=ignore` laisse pam_deny trancher -- c'est le comportement reel de la pile, pas du module.
 *
 * Limites : les piles semees d'Ubuntu 22.04 sont ecrites de memoire (aucun /etc/pam.d reel
 * n'etait accessible) ; les modules qu'elles citent et qui ne sont pas encore portes (pam_cap,
 * pam_umask, pam_systemd...) sont `optional` dans ces fichiers et retombent en
 * PAM_MODULE_UNKNOWN ignore.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { PamReturn } from '@/network/devices/linux/pam/PamReturnCode';
import { recording, runPamSync } from './pamLab';

interface Machine {
  executor: { userMgr: { checkPassword(u: string, p: string): boolean; getAccount(u: string): { expireDate: number; lastChange: number } | undefined }; vfs: { readFile(p: string): string | null; writeFile(p: string, c: string, u: number, g: number, m: number): boolean } };
}

function lab() {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const { userMgr, vfs } = (pc as unknown as Machine).executor;
  return { pc, userMgr, vfs, authLog: () => vfs.readFile('/var/log/auth.log') ?? '' };
}

const root = { uid: 0, euid: 0, loginName: '' };

describe('PAM on the Linux machine', () => {
  let machine: ReturnType<typeof lab>;
  beforeEach(() => { machine = lab(); });

  it('WITNESS -- the ordinary account exists and its password checks out through the legacy path', () => {
    expect(machine.userMgr.checkPassword('user', 'admin')).toBe(true);
  });

  it('the Ubuntu 22.04 stacks are in /etc/pam.d', () => {
    for (const file of ['common-auth', 'common-account', 'common-session', 'common-session-noninteractive', 'common-password', 'sshd', 'login', 'su', 'sudo', 'passwd', 'other']) {
      expect(machine.vfs.readFile(`/etc/pam.d/${file}`), file).not.toBeNull();
    }
    expect(machine.vfs.readFile('/etc/pam.d/common-auth')).toContain('auth\t[success=1 default=ignore]\tpam_unix.so nullok');
  });

  it('the fallback service `other` authenticates with the machine\'s own password', () => {
    const transaction = machine.pc.getPam().begin('other', { caller: root });
    transaction.handle.user = 'user';
    expect(runPamSync(transaction.authenticate(), recording(['admin']).converse)).toBe(PamReturn.SUCCESS);
    expect(runPamSync(machine.pc.getPam().begin('other', { caller: root }).authenticate(), recording(['admin']).converse)).not.toBe(PamReturn.SUCCESS);
  });

  it('a wrong password journals the pam_unix failure under the service name in auth.log', () => {
    const transaction = machine.pc.getPam().begin('other', { caller: root });
    transaction.handle.user = 'user';
    transaction.handle.tty = 'ssh';
    transaction.handle.rhost = '10.0.0.9';
    expect(runPamSync(transaction.authenticate(), recording(['nope']).converse)).toBe(PamReturn.AUTH_ERR);
    expect(machine.authLog()).toMatch(/ other\[\d+\]: pam_unix\(other:auth\): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=10\.0\.0\.9 {2}user=user\n/);
  });

  it('an expired account falls through common-account to pam_deny (PAM_AUTH_ERR), with the message and the journal line', () => {
    machine.userMgr.getAccount('user')!.expireDate = 1;
    const transaction = machine.pc.getPam().begin('other', { caller: root });
    transaction.handle.user = 'user';
    const conversation = recording();
    expect(runPamSync(transaction.acctMgmt(), conversation.converse)).toBe(PamReturn.AUTH_ERR);
    expect(conversation.shown[0].text).toBe('Your account has expired; please contact your system administrator.');
    expect(machine.authLog()).toContain('pam_unix(other:account): account user has expired (account expired)');
  });

  it('a password marked for change forces NEW_AUTHTOK_REQD with the libpam wording', () => {
    machine.userMgr.getAccount('user')!.lastChange = 0;
    const transaction = machine.pc.getPam().begin('other', { caller: root });
    transaction.handle.user = 'user';
    const conversation = recording();
    expect(runPamSync(transaction.acctMgmt(), conversation.converse)).toBe(PamReturn.NEW_AUTHTOK_REQD);
    expect(conversation.shown[0].text).toBe('You are required to change your password immediately (administrator enforced).');
  });

  it('chauthtok changes the account database and /etc/shadow together, then the new password authenticates', () => {
    machine.vfs.writeFile('/etc/pam.d/changer', 'password required pam_unix.so\n', 0, 0, 0o022);
    const transaction = machine.pc.getPam().begin('changer', { caller: root });
    transaction.handle.user = 'user';
    expect(runPamSync(transaction.chauthtok(), recording(['fresh-secret', 'fresh-secret']).converse)).toBe(PamReturn.SUCCESS);
    expect(machine.userMgr.checkPassword('user', 'fresh-secret')).toBe(true);
    expect(machine.userMgr.checkPassword('user', 'admin')).toBe(false);
    expect(machine.vfs.readFile('/etc/shadow')).toMatch(/^user:\$6\$simulated\$fresh-secret:/m);
  });

  it('remember= keeps old passwords in /etc/security/opasswd and refuses a reuse', () => {
    machine.vfs.writeFile('/etc/pam.d/changer', 'password required pam_unix.so remember=5\n', 0, 0, 0o022);
    const own = { uid: 1000, euid: 1000, loginName: 'user' };
    const first = machine.pc.getPam().begin('changer', { caller: own });
    first.handle.user = 'user';
    expect(runPamSync(first.chauthtok(), recording(['admin', 'second-pw', 'second-pw']).converse)).toBe(PamReturn.SUCCESS);
    expect(machine.vfs.readFile('/etc/security/opasswd')).toMatch(/^user:1000:1:\$6\$simulated\$admin\n$/);
    const again = machine.pc.getPam().begin('changer', { caller: own });
    again.handle.user = 'user';
    const conversation = recording(['second-pw', 'admin', 'admin']);
    expect(runPamSync(again.chauthtok(), conversation.converse)).toBe(PamReturn.AUTHTOK_ERR);
    expect(conversation.shown.some((entry) => entry.text === 'Password has been already used. Choose another.')).toBe(true);
    expect(machine.userMgr.checkPassword('user', 'second-pw')).toBe(true);
  });

  it('pam_faillock keeps its tally as a file in the machine\'s /var/run/faillock and locks after three failures', () => {
    machine.vfs.writeFile('/etc/pam.d/guarded', [
      'auth required pam_faillock.so preauth',
      'auth [success=1 default=bad] pam_unix.so',
      'auth [default=die] pam_faillock.so authfail',
      'auth sufficient pam_faillock.so authsucc',
      '',
    ].join('\n'), 0, 0, 0o022);
    const attempt = (password: string) => {
      const transaction = machine.pc.getPam().begin('guarded', { caller: root });
      transaction.handle.user = 'user';
      return runPamSync(transaction.authenticate(), recording([password]).converse);
    };
    expect(attempt('x')).toBe(PamReturn.AUTH_ERR);
    expect(attempt('x')).toBe(PamReturn.AUTH_ERR);
    expect(attempt('x')).toBe(PamReturn.AUTH_ERR);
    expect((machine.vfs.readFile('/var/run/faillock/user') ?? '').trim().split('\n')).toHaveLength(3);
    expect(attempt('admin')).toBe(PamReturn.AUTH_ERR);
    expect(machine.authLog()).toContain('pam_faillock(guarded:auth): Consecutive login failures for user user account temporarily locked');
  });
});
