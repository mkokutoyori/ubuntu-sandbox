/**
 * Une commande qui ne lit pas l'entree standard (mkdir, cd, umask, tail FICHIER...) ne la consomme pas : le `cat` qui suit la recoit,
 * comme avec le `sh -c '... mkdir -p .ssh && cat >> .ssh/authorized_keys'` de ssh-copy-id.
 * Mesure avant le correctif : 4 des 5 cas tombent (la cle n'arrivait jamais dans authorized_keys, cross-equipment-ssh-suite : 7 cas rouges) ;
 * le temoin est `sh -c 'cat >> f'` seul, qui passait deja.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('standard input reaches the first command that reads it', () => {
  let pc: LinuxPC;
  beforeEach(() => {
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
  });

  const through = async (script: string): Promise<string> =>
    pc.executeCommand(`printf 'KEY\\n' | sh -c '${script}'; cat /tmp/out`);

  it('witness: cat alone', async () => {
    expect(await through('cat >> /tmp/out')).toBe('KEY');
  });

  it('after mkdir', async () => {
    expect(await through('mkdir -p /tmp/dd && cat >> /tmp/out')).toBe('KEY');
  });

  it('after cd and umask', async () => {
    expect(await through('cd /tmp; umask 077; cat >> /tmp/out')).toBe('KEY');
  });

  it('after a tail that names a file inside a command substitution', async () => {
    expect(await through('[ -z `tail -1c /nonexistent 2>/dev/null` ] && cat >> /tmp/out')).toBe('KEY');
  });

  it('after the whole ssh-copy-id remote command', async () => {
    const remote = "cd; umask 077; mkdir -p .ssh && { [ -z `tail -1c .ssh/authorized_keys 2>/dev/null` ] || echo >> .ssh/authorized_keys || exit 1; } && cat >> .ssh/authorized_keys || exit 1";
    await pc.executeCommand(`printf 'KEY\\n' | sh -c '${remote}'`);
    expect(await pc.executeCommand('cat ~/.ssh/authorized_keys')).toBe('KEY');
  });
});
