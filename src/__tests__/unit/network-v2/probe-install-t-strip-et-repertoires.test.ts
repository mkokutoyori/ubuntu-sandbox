/**
 * coreutils install : -D avec -t crée le répertoire cible, -v annonce « creating directory », -s/--strip appelle strip (qui refuse un fichier non ELF) ; sorties relevées sur l'install 9.4 de cette machine.
 * Mesure de départ : « install -D -t out/deep src » faisait de « deep » un fichier, -v rendait le code 1 et -s était sans effet. 5 des 6 cas tombent avant ; le témoin (install simple) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('install', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('mkdir -p /tmp/ins; cd /tmp/ins; echo a > src');
  });
  const run = (command: string): Promise<string> => pc.executeCommand(`cd /tmp/ins; ${command}`);

  it('-D -t crée le répertoire cible', async () => {
    await run('install -D -t out/deep src');
    expect(await run('ls out/deep')).toBe('src');
  });
  it('-D -t -v annonce chaque répertoire créé', async () => {
    expect(await run('install -D -t out2/d3 -v src; echo rc=$?')).toBe("install: creating directory 'out2'\ninstall: creating directory 'out2/d3'\n'src' -> 'out2/d3/src'\nrc=0");
  });
  it('-s refuse un fichier qui n\'est pas un exécutable', async () => {
    expect(await run('install -s src stripped 2>&1; echo rc=$?')).toBe('strip: stripped: file format not recognized\ninstall: strip process terminated abnormally\nrc=1');
  });
  it('-s ne laisse pas le fichier cible', async () => {
    await run('install -s src stripped');
    expect(await run('ls stripped 2>&1')).toBe("ls: cannot access 'stripped': No such file or directory");
  });
  it('--strip fait de même', async () => {
    expect(await run('install --strip -m 600 src s2 2>&1; echo rc=$?')).toBe('strip: s2: file format not recognized\ninstall: strip process terminated abnormally\nrc=1');
  });
  it('témoin : install simple', async () => { expect(await run('install -m 600 src plain; ls -l plain | cut -c1-10')).toBe('-rw-------'); });
});
