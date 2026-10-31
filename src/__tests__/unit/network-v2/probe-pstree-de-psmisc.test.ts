/**
 * psmisc 23.7 pstree : arbre ASCII « -+- » / « --- », tri par nom, regroupement « N*[...] », -c, -p, -a, -n, -U, -A, -V, utilisateur inconnu, option inconnue, et usage dans un tube ; formes relevées sur le pstree réel de cette machine avec une arborescence de même forme (bash → 3 sleep dont deux identiques et un bash → 2 sleep identiques).
 * Mesure de départ : un arbre dessiné en retrait avec des caractères de ligne, aucun regroupement, « pstree | head » refusé (« invalid option »). 9 des 10 cas tombent avant ; le témoin (pstree d'un pid inexistant sans sortie) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('pstree', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sleep 307 &');
    await pc.executeCommand('sleep 307 &');
    await pc.executeCommand('sleep 308 &');
    await pc.executeCommand('bash -c "sleep 309 & sleep 309 & wait" &');
  });
  const tree = (options: string): Promise<string> => pc.executeCommand(`pstree ${options} $$ | sed 's/[0-9][0-9]*/N/g'`);

  it('regroupe les frères identiques et trie par nom', async () => {
    const out = await pc.executeCommand('pstree -A $$');
    expect(out).toMatch(/^bash-\+-/);
    expect(out).toMatch(/2\*\[sleep\]/);
    expect(out).toMatch(/\n\s+`-.*sleep/);
  });
  it('-c ne regroupe pas', async () => { expect(await pc.executeCommand('pstree -A -c $$')).not.toMatch(/\*\[/); });
  it('-p donne les pids et ne regroupe pas', async () => {
    expect(await tree('-A -p')).toMatch(/^bash\(N\)-\+-/);
    expect(await pc.executeCommand('pstree -p $$')).not.toContain('*[');
  });
  it('-a rend la ligne de commande, un processus par ligne', async () => { expect(await pc.executeCommand('pstree -A -a $$')).toMatch(/\n  \|-.*\n/); });
  it('-A et -U choisissent le jeu de caractères', async () => {
    expect(await pc.executeCommand('pstree -A $$')).toContain('-+-');
    expect(await pc.executeCommand('pstree -U $$')).toContain('─┬─');
  });
  it('par défaut, dans une locale UTF-8, les traits sont Unicode', async () => {
    expect(await pc.executeCommand('pstree $$')).toContain('─');
  });
  it('-V', async () => { expect(await pc.executeCommand('pstree -V | head -1')).toBe('pstree (PSmisc) 23.7'); });
  it('utilisateur inconnu', async () => { expect(await pc.executeCommand('pstree nosuchuser; echo rc=$?')).toBe('No such user name: nosuchuser\nrc=1'); });
  it('option inconnue', async () => {
    expect(await pc.executeCommand('pstree -Q 2>&1 | head -2')).toBe("pstree: invalid option -- 'Q'\nUsage: pstree [-acglpsStTuZ] [ -h | -H PID ] [ -n | -N type ]");
  });
  it('dans un tube', async () => { expect(await pc.executeCommand('pstree | head -1')).not.toContain('invalid option'); });
  it('témoin : pid inexistant, aucune sortie', async () => { expect(await pc.executeCommand('pstree 99999999; echo rc=$?')).toBe('rc=0'); });
});
