/**
 * watch procps-ng 4.0.4 : en-tête « Every N.Ns: cmd » avec l'intervalle à une décimale (borné à 0.1), hôte et date calés à droite sur 80 colonnes, usage complet, -v, diagnostics getopt ; sorties relevées sur le vrai watch de cette machine.
 * Mesure de départ : en-tête « Every 2s: », heure seule, « no command given », options inconnues ignorées en silence. 10 des 12 cas tombent avant ; les témoins (-t sans en-tête, code de sortie propagé) passent dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('watch de procps', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });
  const run = (line: string): Promise<string> => pc.executeCommand(line);

  it('en-tête à une décimale, hôte et date à droite sur 80 colonnes', async () => {
    const first = (await run('watch echo hi')).split('\n')[0];
    expect(first).toMatch(/^Every 2\.0s: echo hi +PC1: \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
    expect(first.length).toBe(80);
  });
  it('-n 2.55 s\'affiche 2.5', async () => { expect((await run('watch -n 2.55 true')).startsWith('Every 2.5s: true')).toBe(true); });
  it('-n 0 est relevé à 0.1', async () => { expect((await run('watch -n 0 true')).startsWith('Every 0.1s: true')).toBe(true); });
  it('-n abc', async () => { expect(await run('watch -n abc ls')).toBe("watch: failed to parse argument: 'abc': Invalid argument"); });
  it('-n1x', async () => { expect(await run('watch -n1x true')).toBe("watch: failed to parse argument: '1x': Invalid argument"); });
  it('option inconnue : diagnostic puis usage', async () => {
    const out = await run('watch --bogus ls');
    expect(out.startsWith("watch: unrecognized option '--bogus'\n\nUsage:\n watch [options] command\n\nOptions:")).toBe(true);
  });
  it('-n sans valeur', async () => { expect((await run('watch -n')).startsWith("watch: option requires an argument -- 'n'\n\nUsage:")).toBe(true); });
  it('sans commande : usage', async () => { expect((await run('watch')).startsWith('\nUsage:\n watch [options] command\n\nOptions:')).toBe(true); });
  it('-v', async () => { expect(await run('watch -v')).toBe('watch from procps-ng 4.0.4'); });
  it('-h liste -q, --equexit', async () => { expect(await run('watch -h')).toContain('  -q, --equexit <cycles>\n                         exit when output from command does not change'); });
  it('témoin : -t ne montre pas l\'en-tête', async () => { expect(await run('watch -t echo bare')).toBe('bare'); });
  it('témoin : le code de sortie du programme passe', async () => { expect(await run('watch -t false || echo PROP')).toContain('PROP'); });
});
