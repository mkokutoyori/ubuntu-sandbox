/**
 * bash 5.2 FUNCNAME / BASH_SOURCE / BASH_LINENO : un fichier chargé par « source » ouvre un cadre « source », et une fonction garde le fichier où elle est définie ; sorties relevées sur le bash réel de cette machine.
 * Mesure de départ : le fichier source apparaissait sous le nom du script et aucun cadre « source » n'existait. 3 des 5 cas tombent avant ; le témoin (appel de fonction dans le script seul) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('cadres d\'appel et source', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(`printf 'f() { echo "F: \${FUNCNAME[*]} | \${BASH_SOURCE[*]} | \${BASH_LINENO[*]}"; }\\necho "S: \${BASH_SOURCE[*]} | \${FUNCNAME[*]-none}"\\nf\\n' > /tmp/lib.sh`);
    await pc.executeCommand(`printf 'source /tmp/lib.sh\\nf\\ng() { f; }\\ng\\necho "M: \${BASH_SOURCE[*]}"\\n' > /tmp/main.sh`);
    await pc.executeCommand(`printf 'h() { echo "H: \${FUNCNAME[*]} | \${BASH_SOURCE[*]} | \${BASH_LINENO[*]}"; }\\nh\\n' > /tmp/alone.sh`);
  });
  const run = (script: string): Promise<string> => pc.executeCommand(`cd /tmp; bash ${script}`);

  it('au niveau supérieur du fichier chargé', async () => {
    expect((await run('main.sh')).split('\n')[0]).toBe('S: /tmp/lib.sh main.sh | none');
  });
  it('fonction appelée depuis le fichier chargé', async () => {
    expect((await run('main.sh')).split('\n')[1]).toBe('F: f source main | /tmp/lib.sh /tmp/lib.sh main.sh | 3 1 0');
  });
  it('la fonction garde son fichier de définition quand elle est appelée du script', async () => {
    const lines = (await run('main.sh')).split('\n');
    expect(lines[2]).toBe('F: f main | /tmp/lib.sh main.sh | 2 0');
    expect(lines[3]).toBe('F: f g main | /tmp/lib.sh main.sh main.sh | 3 4 0');
  });
  it('de retour dans le script', async () => { expect((await run('main.sh')).split('\n')[4]).toBe('M: main.sh'); });
  it('témoin : un script sans source', async () => { expect(await run('alone.sh')).toBe('H: h main | alone.sh alone.sh | 2 0'); });
});
