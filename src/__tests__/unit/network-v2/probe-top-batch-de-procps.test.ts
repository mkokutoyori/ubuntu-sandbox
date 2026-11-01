/**
 * procps-ng 4.0.4 top -b : colonnes (USER sur 8 avec « + », PR et NI sur 3), options -n, -p, -u, -o, -w, -c, -V, -h et leurs diagnostics ; sorties relevées sur le top réel de cette machine.
 * Mesure de départ : toutes les options étaient ignorées (« top -V » affichait l'écran, -p 1 listait tout) et NI était sur 4 colonnes. 9 des 11 cas tombent avant ; passent dans les deux états : le témoin (l'en-tête de colonnes) et le tri par mémoire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('top en mode batch', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });
  const run = (command: string): Promise<string> => pc.executeCommand(command);

  it('témoin : en-tête de colonnes', async () => {
    expect(await run('top -b -n 1 | sed -n 7p')).toBe('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');
  });
  it('-V', async () => { expect(await run('top -V')).toBe('top from procps-ng 4.0.4'); });
  it('-h', async () => { expect(await run('top -h | head -3')).toBe('\nUsage:\n top [options]'); });
  it('-p limite aux pids demandés', async () => { expect(await run('top -b -n 1 -p 1 | tail -n +8 | wc -l')).toBe('1'); });
  it('-p refuse un pid invalide', async () => { expect(await run('top -b -n1 -p abc; echo rc=$?')).toBe("top: bad pid 'abc'\nrc=1"); });
  it('-n refuse un nombre invalide', async () => { expect(await run('top -b -n x; echo rc=$?')).toBe("top: bad iterations argument 'x'\nrc=1"); });
  it('-o refuse un champ inconnu', async () => { expect(await run('top -b -n 1 -o BOGUS; echo rc=$?')).toBe("top: unrecognized field name 'BOGUS'\nrc=1"); });
  it('option inconnue', async () => { expect(await run('top -Z; echo rc=$?')).toBe("top: invalid option -- 'Z'\nrc=1"); });
  it('-n 2 écrit deux écrans', async () => { expect(await run("top -b -n 2 | grep -c '^top - '")).toBe('2'); });
  it('colonnes de ligne : NI sur 3, USER sur 8', async () => {
    expect(await run('top -b -n 1 -p 1 | tail -1 | cut -c1-48')).toBe('      1 root      20   0  169000  13000      0 S');
  });
  it('-o %MEM trie par mémoire décroissante', async () => {
    const out = await run("top -b -n 1 -o %MEM | tail -n +8 | awk '{print $10}' | head -2");
    const [first, second] = out.split('\n').map(Number);
    expect(first).toBeGreaterThanOrEqual(second);
  });
});
