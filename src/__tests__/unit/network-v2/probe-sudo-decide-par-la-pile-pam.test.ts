/**
 * sudo (service /etc/pam.d/sudo de l'Ubuntu 22.04 semee) laisse la pile decider : pam_authenticate
 * avec le mot de passe de l'APPELANT, pam_acct_mgmt, puis pam_open_session / pam_close_session
 * autour de la commande, PAM_USER valant la cible. Le journal de sudo n'a pas de pid
 * (syslog sans LOG_PID) et son nom d'utilisateur est cadre a droite sur 8 colonnes (logging.c :
 * « %8s : »), comme dans « sudo:    alice : TTY=pts/0 ; PWD=... ».
 *
 * MESURE DE DEPART, LinuxPC, utilisateur `user` (uid 1000) :
 *  - le journal ne portait que « sudo: user : TTY=pts/0 ; ... » (nom colle, ecrit directement
 *    dans auth.log sans passer par le journal) et, pour un echec, une ligne pam_unix ECRITE A LA
 *    MAIN avec `tty=pts/0` au lieu de `tty=/dev/pts/0` ;
 *  - aucune ligne `pam_unix(sudo:session): session opened ... by user(uid=1000)` ni `session
 *    closed` : la session n'existait pas ;
 *  - un compte expire (chage -E 0) continuait de sudoer : pam_acct_mgmt n'etait pas lu ;
 *  - un account `required pam_deny.so` dans /etc/pam.d/sudo ne refusait rien ;
 *  - le flux interactif validait par checkPassword (le compteur de refus du gestionnaire de
 *    comptes) : aucune ligne `2 more authentication failures` en fin de transaction, aucune ligne
 *    d'audit « 3 incorrect password attempts » et le dernier message restait « Sorry, try again. ».
 * Discriminee contre l'etat d'avant (`git stash push -- src/network src/shell`) : 7 des 9 cas
 * tombent. Temoins (verts avant et apres) : « sudo whoami rend root » et « le mot de passe juste passe
 * avec sudo -S », qui prouvent le labo.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

async function labo() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  await pc.executeCommand('echo "user:userpw" | sudo chpasswd');
  const sudoLines = async () => String(await pc.executeCommand('sudo cat /var/log/auth.log'))
    .split('\n').filter((line) => / sudo(\[\d+\])?: /.test(line)).map((line) => line.replace(/^.*? (sudo(\[\d+\])?: )/, '$1'));
  return { pc, sudoLines };
}

function passwordStep(pc: LinuxPC, command: string) {
  const plan = pc.interactionPlanFor(command, { currentUser: 'user', currentUid: 1000 });
  const step = plan!.steps[0];
  if (step.kind !== 'password') throw new Error('first step is not a password prompt');
  return step;
}

describe('sudo decided by the PAM stack', () => {
  it('sudo whoami answers root — WITNESS', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('sudo whoami')).toBe('root');
  });

  it('the right password passes with sudo -S — WITNESS', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('echo userpw | sudo -S whoami')).toBe('root');
  });

  it('a successful sudo logs the command line, opens then closes the session, without a pid', async () => {
    const { pc, sudoLines } = await labo();
    await pc.executeCommand('sudo whoami');
    const lines = await sudoLines();
    const command = lines.findIndex((line) => line.endsWith('COMMAND=/usr/bin/whoami'));
    const opened = lines.findIndex((line, index) => index > command && line === 'sudo: pam_unix(sudo:session): session opened for user root(uid=0) by user(uid=1000)');
    const closed = lines.findIndex((line, index) => index > opened && line === 'sudo: pam_unix(sudo:session): session closed for user root');
    expect(command).toBeGreaterThanOrEqual(0);
    expect(opened).toBeGreaterThan(command);
    expect(closed).toBeGreaterThan(opened);
  });

  it('the user name is right-aligned on 8 columns', async () => {
    const { pc, sudoLines } = await labo();
    await pc.executeCommand('sudo whoami');
    expect((await sudoLines()).some((line) => line.startsWith('sudo:     user : TTY=pts/0 ; PWD='))).toBe(true);
  });

  it('a wrong password with sudo -S writes the pam_unix failure with the /dev tty then the attempt line', async () => {
    const { pc, sudoLines } = await labo();
    expect(await pc.executeCommand('echo wrong | sudo -S whoami')).toBe('[sudo] password for user: \nSorry, try again.\nsudo: 1 incorrect password attempt');
    const lines = await sudoLines();
    expect(lines).toContain('sudo: pam_unix(sudo:auth): authentication failure; logname=user uid=1000 euid=0 tty=/dev/pts/0 ruser=user rhost=  user=user');
    expect(lines.some((line) => /^sudo:     user : 1 incorrect password attempt ; TTY=pts\/0 ;/.test(line))).toBe(true);
  });

  it('an expired invoking account is refused by the account phase', async () => {
    const { pc } = await labo();
    await pc.executeCommand('sudo chage -E 0 user');
    expect(await pc.executeCommand('sudo whoami')).toBe('Your account has expired; please contact your system administrator.\nsudo: account validation failure, is your account locked?');
    const vfs = (pc as unknown as { executor: { vfs: { readFile(path: string): string | null } } }).executor.vfs;
    expect(vfs.readFile('/var/log/auth.log')).toContain('sudo: pam_unix(sudo:account): account user has expired (account expired)');
  });

  it('an account line required pam_deny.so in /etc/pam.d/sudo refuses every sudo', async () => {
    const { pc } = await labo();
    await pc.executeCommand("sudo sed -i 's/^@include common-account/account required pam_deny.so/' /etc/pam.d/sudo");
    expect(await pc.executeCommand('sudo whoami')).toBe('sudo: account validation failure, is your account locked?');
  });

  it('three wrong passwords in the interactive flow log one failure, the aggregate and the audit line', async () => {
    const { pc, sudoLines } = await labo();
    const step = passwordStep(pc, 'sudo whoami');
    const verdicts = ['a', 'b', 'c'].map((attempt) => step.validate(attempt, new Map()));
    expect(verdicts.map((verdict) => verdict.errorMessage)).toEqual([
      'Sorry, try again.', 'Sorry, try again.', 'sudo: 3 incorrect password attempts',
    ]);
    const lines = await sudoLines();
    expect(lines.filter((line) => line.startsWith('sudo: pam_unix(sudo:auth): authentication failure;')).length).toBe(1);
    expect(lines).toContain('sudo: PAM 2 more authentication failures; logname=user uid=1000 euid=0 tty=/dev/pts/0 ruser=user rhost=  user=user');
    expect(lines.some((line) => /^sudo:     user : 3 incorrect password attempts ; TTY=pts\/0 ; PWD=.* ; USER=root ; COMMAND=\/usr\/bin\/whoami$/.test(line))).toBe(true);
  });

  it('the right password in the interactive flow is accepted and the run then opens the session', async () => {
    const { pc, sudoLines } = await labo();
    const before = (await sudoLines()).filter((line) => line.includes('session opened for user root')).length;
    const step = passwordStep(pc, 'sudo whoami');
    expect(step.validate('userpw', new Map())).toEqual({ valid: true });
    expect(await pc.executeCommand('sudo whoami')).toBe('root');
    const opened = (await sudoLines()).filter((line) => line.includes('session opened for user root')).length;
    expect(opened - before).toBe(2);
  });
});
