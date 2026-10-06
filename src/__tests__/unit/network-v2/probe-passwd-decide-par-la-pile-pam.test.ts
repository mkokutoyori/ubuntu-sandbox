/**
 * passwd, chpasswd et adduser changent un mot de passe par pam_chauthtok sur la pile
 * /etc/pam.d/passwd et /etc/pam.d/chpasswd (@include common-password de l'Ubuntu 22.04 :
 * pam_pwquality retry=3, pam_unix use_authtok, pam_deny en repli). Les invites, les refus
 * (« BAD PASSWORD: ... »), le « password changed for » et le message final viennent de la pile
 * et de passwd.c de shadow-utils (« passwd: <pam_strerror> » puis « passwd: password unchanged »).
 *
 * MESURE DE DEPART, LinuxPC, utilisateur `user` (mot de passe `userpw`) :
 *  - `passwd` en script rendait « passwd: password updated successfully » SANS rien changer ;
 *  - le flux interactif n'exigeait qu'un mot de passe non vide : « abc » etait accepte par un
 *    non-root, la faiblesse n'etant qu'un avertissement ecrit a la main
 *    (`pam_pwquality(passwd:chauthtok): weak password accepted with warning`) ;
 *  - un mauvais mot de passe courant etait refuse par checkPassword (compteur de refus du
 *    gestionnaire de comptes) et non par pam_unix ;
 *  - /etc/pam.d/common-password n'existait pas : `enforce_for_root` ou le retrait de
 *    pam_pwquality n'avaient aucun effet ;
 *  - chpasswd stockait n'importe quoi sans transaction, un utilisateur inconnu passait en
 *    silence ;
 *  - aucune ligne `pam_unix(passwd:chauthtok): password changed for X`.
 * Discriminee contre l'etat d'avant (`git stash push -- src/network src/shell src/terminal`) :
 * 11 des 12 cas tombent. Le seul cas qui passe des deux cotes est « retirer pam_pwquality laisse
 * un non-root choisir un mot de passe faible » : avant, rien ne le refusait ; apres, la pile le
 * permet parce qu'on a retire la ligne (non-regression de la configuration). Les cas « root
 * change le mot de passe d'un autre » et « le nouveau mot de passe ouvre une session » servent de
 * temoins du labo apres le changement.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

async function labo() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  await pc.executeCommand('echo "user:userpw" | sudo chpasswd');
  await pc.executeCommand('sudo useradd -m -s /bin/bash alice');
  await pc.executeCommand('echo "alice:alicepw1" | sudo chpasswd');
  const authLog = async () => String(await pc.executeCommand('sudo cat /var/log/auth.log'));
  const su = (password: string) => pc.executeCommand(`echo ${password} | su alice -c whoami`);
  return { pc, authLog, su };
}

describe('passwd and chpasswd decided by the PAM stack', () => {
  it('root changes the password of another user — WITNESS', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('printf "newpass99\\nnewpass99\\n" | sudo passwd alice'))
      .toBe('New password: Retype new password: passwd: password updated successfully');
  });

  it('the new password opens a session and the old one no longer does — WITNESS', async () => {
    const { pc, su } = await labo();
    await pc.executeCommand('printf "newpass99\\nnewpass99\\n" | sudo passwd alice');
    expect(await su('newpass99')).toBe('alice');
    expect(await su('alicepw1')).toBe('su: Authentication failure');
  });

  it('the change is logged by pam_unix under the passwd service', async () => {
    const { pc, authLog } = await labo();
    await pc.executeCommand('printf "newpass99\\nnewpass99\\n" | sudo passwd alice');
    expect(await authLog()).toMatch(/passwd\[\d+\]: pam_unix\(passwd:chauthtok\): password changed for alice/);
  });

  it('a non-root user is asked for the current password first', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('printf "userpw\\nStr0ng!pass1\\nStr0ng!pass1\\n" | passwd'))
      .toBe('Changing password for user.\nCurrent password: New password: Retype new password: passwd: password updated successfully');
  });

  it('a weak password is refused for a non-root user by pam_pwquality, three tries then failure', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('printf "userpw\\nabc\\nabc\\nabc\\nabc\\nabc\\nabc\\n" | passwd');
    expect(out).toContain('BAD PASSWORD: The password is shorter than 8 characters');
    expect(out.endsWith('passwd: Have exhausted maximum number of retries for service\npasswd: password unchanged')).toBe(true);
    expect(await pc.executeCommand('printf "userpw\\nStr0ng!pass1\\nStr0ng!pass1\\n" | passwd')).toContain('password updated successfully');
  });

  it('a wrong current password stops the change with the pam_deny verdict', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('printf "wrong\\nStr0ng!pass1\\nStr0ng!pass1\\n" | passwd'))
      .toBe('Changing password for user.\nCurrent password: passwd: Authentication token manipulation error\npasswd: password unchanged');
  });

  it('root is only warned about a weak password, as pam_pwquality does without enforce_for_root', async () => {
    const { pc, su } = await labo();
    expect(await pc.executeCommand('printf "abc\\nabc\\n" | sudo passwd alice')).toContain('passwd: password updated successfully');
    expect(await su('abc')).toBe('alice');
  });

  it('enforce_for_root added to common-password makes the stack refuse root too', async () => {
    const { pc, su } = await labo();
    await pc.executeCommand("sudo sed -i 's/pam_pwquality.so retry=3/pam_pwquality.so retry=3 enforce_for_root/' /etc/pam.d/common-password");
    const out = await pc.executeCommand('printf "abc\\nabc\\nabc\\nabc\\nabc\\nabc\\n" | sudo passwd alice');
    expect(out).toContain('BAD PASSWORD: The password is shorter than 8 characters');
    expect(out.endsWith('passwd: password unchanged')).toBe(true);
    expect(await su('alicepw1')).toBe('alice');
  });

  it('removing pam_pwquality from common-password lets a non-root user choose a weak password', async () => {
    const { pc } = await labo();
    await pc.executeCommand("sudo sed -i '/pam_pwquality/d; s/ use_authtok//' /etc/pam.d/common-password");
    expect(await pc.executeCommand('printf "userpw\\nabc12345\\nabc12345\\n" | passwd')).toContain('passwd: password updated successfully');
  });

  it('chpasswd runs one chauthtok per line and reports an unknown user like shadow-utils', async () => {
    const { pc, su } = await labo();
    expect(await pc.executeCommand('printf "alice:chpass99\\nghost:whatever\\n" | sudo chpasswd')).toBe([
      "chpasswd: line 2: user 'ghost' does not exist",
      'chpasswd: error detected, changes ignored',
    ].join('\n'));
    expect(await su('chpass99')).toBe('alice');
  });

  it('a chauthtok refused by the stack is reported per line with the pam_strerror text', async () => {
    const { pc } = await labo();
    await pc.executeCommand("sudo sed -i 's/pam_pwquality.so retry=3/pam_pwquality.so retry=3 enforce_for_root/' /etc/pam.d/common-password");
    expect(await pc.executeCommand('echo alice:abc | sudo chpasswd')).toBe([
      'chpasswd: (user alice) pam_chauthtok() failed, error:',
      'Have exhausted maximum number of retries for service',
      'chpasswd: (line 1, user alice) password not changed',
      'chpasswd: error detected, changes ignored',
    ].join('\n'));
  });

  it('the interactive flow drives the same transaction, prompt by prompt', async () => {
    const { pc } = await labo();
    const plan = pc.interactionPlanFor('passwd', { currentUser: 'user', currentUid: 1000 })!;
    const password = plan.steps.find((step) => step.kind === 'password');
    expect(password).toBeDefined();
    if (password?.kind !== 'password') throw new Error('no password step');
    expect(password.prompt).toBe('Current password: ');
    expect(password.validate!('userpw', new Map())).toEqual({ valid: true });
    expect(password.prompt).toBe('New password: ');
    password.validate!('Str0ng!pass1', new Map());
    expect(password.prompt).toBe('Retype new password: ');
  });
});
