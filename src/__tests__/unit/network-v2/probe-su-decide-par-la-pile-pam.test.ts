/**
 * su et su - (services /etc/pam.d/su et su-l de l'Ubuntu 22.04 semee) laissent la pile decider :
 * authentification (pam_rootok, pam_wheel eventuel, pam_unix), phase compte, session ouverte
 * puis fermee, journal. Le binaire est util-linux su-common.c : « (to X) Y on pts/0 » au succes,
 * « FAILED SU (to X) Y on pts/0 » a l'echec, errx("%s", pam_strerror) pour le refus, et un
 * shell nologin imprime « This account is currently not available. » apres l'ouverture de
 * session.
 *
 * MESURE DE DEPART, LinuxPC, utilisateur `user` (uid 1000) puis `carol` :
 *  - un mauvais mot de passe ne journalisait que « FAILED su for carol by user(uid=1000) »
 *    (format de shadow-utils), sans la ligne `pam_unix(su:auth): authentication failure;
 *    logname=user uid=1000 euid=0 tty=/dev/pts/0 ruser=user rhost=  user=carol` ;
 *  - la ligne `pam_unix(su:session): session opened` etait ecrite A LA MAIN et aucune ligne
 *    `session closed` n'existait jamais ;
 *  - un compte expire (chage -E 0) se laissait atteindre depuis root : la phase compte n'etait
 *    pas lue ;
 *  - `auth required pam_wheel.so` decommente dans /etc/pam.d/su ne refusait personne ;
 *  - su vers un compte nologin disait « su: user X does not have a login shell » (phrase
 *    d'aucun programme) ;
 *  - le flux interactif validait le mot de passe lui-meme (3 essais) : deux authentifications
 *    par su, et une relance que su ne fait pas.
 * Discriminee contre l'etat d'avant (`git stash push -- src/network src/shell`) : 8 des 10 cas
 * tombent. Temoins (verts avant et apres) : « le bon mot de passe change d'identite » et « root
 * change d'identite sans mot de passe », qui prouvent le labo.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { buildLinuxInteractionPlan } from '@/network/devices/linux/interaction/LinuxInteractionPlanner';

async function labo() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  await pc.executeCommand('sudo useradd -m -s /bin/bash carol');
  await pc.executeCommand('echo "carol:carolpw" | sudo chpasswd');
  await pc.executeCommand('sudo useradd -m -s /usr/sbin/nologin svc');
  await pc.executeCommand('echo "svc:svcpw" | sudo chpasswd');
  const su = (args: string, password: string) => pc.executeCommand(`echo ${password} | su ${args}`);
  const authLog = async () => String(await pc.executeCommand('sudo cat /var/log/auth.log'));
  const suLines = async () => (await authLog()).split('\n').filter((line) => / su(\[\d+\])?: /.test(line)).map((line) => line.replace(/^.*? su(\[\d+\])?: /, ''));
  return { pc, suLines, su };
}

describe('su decided by the PAM stack', () => {
  it('the right password switches identity — WITNESS', async () => {
    const { pc, su } = await labo();
    expect(await su('carol -c whoami', 'carolpw')).toBe('carol');
  });

  it('root switches identity without a password — WITNESS', async () => {
    const { pc, su } = await labo();
    expect(await pc.executeCommand('sudo su carol -c whoami')).toBe('carol');
  });

  it('a wrong password writes the pam_unix failure line before the FAILED SU line', async () => {
    const { pc, suLines, su } = await labo();
    expect(await su('carol -c whoami', 'wrong')).toBe('su: Authentication failure');
    const lines = await suLines();
    expect(lines).toContain('pam_unix(su:auth): authentication failure; logname=user uid=1000 euid=0 tty=/dev/pts/0 ruser=user rhost=  user=carol');
    expect(lines).toContain('FAILED SU (to carol) user on pts/0');
    expect(lines.indexOf('FAILED SU (to carol) user on pts/0')).toBeGreaterThan(lines.findIndex((line) => line.startsWith('pam_unix(su:auth)')));
  });

  it('a successful su opens the session through pam_unix and closes it when su ends', async () => {
    const { pc, suLines, su } = await labo();
    await su('carol -c whoami', 'carolpw');
    const lines = await suLines();
    expect(lines).toContain('(to carol) user on pts/0');
    const carolUid = String(await pc.executeCommand('id -u carol')).trim();
    expect(lines).toContain(`pam_unix(su:session): session opened for user carol(uid=${carolUid}) by user(uid=1000)`);
    expect(lines).toContain('pam_unix(su:session): session closed for user carol');
  });

  it('an interactive su keeps the session open until exit', async () => {
    const { pc, suLines, su } = await labo();
    await su('carol', 'carolpw');
    expect((await suLines()).some((line) => line.includes('session closed'))).toBe(false);
    (pc as unknown as { handleExit: () => unknown }).handleExit();
    expect((await suLines()).some((line) => line.includes('session closed for user carol'))).toBe(true);
  });

  it('an expired account is refused by the account phase even for root', async () => {
    const { pc, su } = await labo();
    await pc.executeCommand('sudo chage -E 0 carol');
    const out = await pc.executeCommand('sudo su carol -c whoami');
    expect(out).toContain('Your account has expired; please contact your system administrator.');
    expect(out).toContain('su: Authentication failure');
    expect(out).not.toContain('carol\n');
  });

  it('pam_wheel uncommented in /etc/pam.d/su refuses a user who is not in group root', async () => {
    const { pc, suLines, su } = await labo();
    await pc.executeCommand('sudo useradd -m dave');
    await pc.executeCommand('sudo usermod -aG root dave');
    await pc.executeCommand("sudo sed -i 's/^# auth       required   pam_wheel.so/auth       required   pam_wheel.so/' /etc/pam.d/su");
    expect(await su('carol -c whoami', 'carolpw')).toBe('su: Permission denied');
    expect((await suLines()).some((line) => line.startsWith('FAILED SU (to carol)'))).toBe(true);
  });

  it('a nologin shell opens and closes the session then prints the nologin notice', async () => {
    const { pc, suLines, su } = await labo();
    expect(await su('svc', 'svcpw')).toBe('This account is currently not available.');
    const lines = await suLines();
    expect(lines.some((line) => line.startsWith('pam_unix(su:session): session opened for user svc'))).toBe(true);
    expect(lines).toContain('pam_unix(su:session): session closed for user svc');
  });

  it('su - goes through the su-l service', async () => {
    const { pc, su } = await labo();
    await pc.executeCommand("sudo sed -i '1i auth required pam_deny.so' /etc/pam.d/su-l");
    expect(await su('- carol -c whoami', 'carolpw')).toBe('su: Authentication failure');
    expect(await su('carol -c whoami', 'carolpw')).toBe('carol');
  });

  it('the interactive flow leaves the verdict to su: no second authentication, no retry', () => {
    const plan = buildLinuxInteractionPlan('su carol', { currentUser: 'user', currentUid: 1000 }, { canSudo: () => false, checkPassword: () => false });
    const step = plan!.steps[0];
    expect(step.kind).toBe('password');
    const verdict = step.kind === 'password' ? step.validate('wrong', new Map()) : null;
    expect(verdict).toEqual({ valid: true });
  });
});
