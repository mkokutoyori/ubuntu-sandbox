/**
 * coreutils mknod, find -type b|c, ls -l (numéros majeur/mineur), test -b, stat : sorties relevées sur mknod/find/ls/file réels (coreutils 9.4, le texte d'aide en vient).
 * Mesure de départ : « mknod » n'existait pas, find -type b rendait tous les périphériques caractère, test -b rendait toujours faux. 10 des 11 cas tombent avant ; le témoin (find -type c sur /dev/null) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('mknod et périphériques', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sudo mkdir /tmp/mk; sudo chmod 777 /tmp/mk; cd /tmp/mk');
  });
  const root = (command: string): Promise<string> => pc.executeCommand(`cd /tmp/mk; sudo ${command}`);

  it('manque d\'opérande', async () => { expect(await pc.executeCommand('mknod; echo rc=$?')).toBe("mknod: missing operand\nTry 'mknod --help' for more information.\nrc=1"); });
  it('type invalide', async () => { expect(await pc.executeCommand('mknod a z 1 2; echo rc=$?')).toBe("mknod: invalid device type 'z'\nTry 'mknod --help' for more information.\nrc=1"); });
  it('numéros requis', async () => {
    expect(await pc.executeCommand('mknod a b; echo rc=$?')).toBe("mknod: missing operand after 'b'\nSpecial files require major and minor device numbers.\nTry 'mknod --help' for more information.\nrc=1");
  });
  it('un tube n\'a pas de numéros', async () => {
    expect(await pc.executeCommand('mknod a p 1 2; echo rc=$?')).toBe("mknod: extra operand '1'\nFifos do not have major and minor device numbers.\nTry 'mknod --help' for more information.\nrc=1");
  });
  it('un non-root ne crée pas de périphérique', async () => {
    expect(await pc.executeCommand('cd /tmp/mk; mknod b1 b 7 9; echo rc=$?')).toBe('mknod: b1: Operation not permitted\nrc=1');
  });
  it('ls -l montre majeur et mineur', async () => {
    await root('mknod -m 600 b1 b 7 9');
    await root('mknod c1 c 1 3');
    expect(await pc.executeCommand('cd /tmp/mk; ls -l')).toBe('total 0\nbrw------- 1 root root 7, 9 ' + (await pc.executeCommand('date +"%b %e %H:%M"')).replace(/\s+/g, ' ') + ' b1\ncrw-r--r-- 1 root root 1, 3 ' + (await pc.executeCommand('date +"%b %e %H:%M"')).replace(/\s+/g, ' ') + ' c1');
  });
  it('find -type b ne rend que les blocs', async () => {
    await root('mknod b1 b 7 9');
    await root('mknod c1 c 1 3');
    expect(await pc.executeCommand('cd /tmp/mk; find . -type b')).toBe('./b1');
    expect(await pc.executeCommand('cd /tmp/mk; find . -type c')).toBe('./c1');
  });
  it('test -b', async () => {
    await root('mknod b1 b 7 9');
    expect(await pc.executeCommand('cd /tmp/mk; test -b b1; echo $?; test -b /dev/null; echo $?')).toBe('0\n1');
  });
  it('stat et file', async () => {
    await root('mknod b1 b 7 9');
    expect(await pc.executeCommand("cd /tmp/mk; stat -c '%F %t %T' b1")).toBe('block special file 7 9');
    expect(await pc.executeCommand('cd /tmp/mk; file b1')).toBe('b1: block special (7/9)');
  });
  it('un périphérique 1:3 se comporte comme /dev/null', async () => {
    await root('mknod n1 c 1 3');
    expect(await pc.executeCommand('cd /tmp/mk; cat n1; echo rc=$?')).toBe('rc=0');
  });
  it('témoin : find -type c sur /dev/null', async () => { expect(await pc.executeCommand('find /dev -maxdepth 1 -name null -type c')).toBe('/dev/null'); });
});
