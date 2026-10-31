/**
 * Le tableau des jobs (`jobs`, `%1`, `wait`) appartient a UN shell. bash 5.2.21 sur la machine de reference :
 *   sleep 100 & jobs; bash -c 'jobs; echo inner'      -> l'enfant n'affiche rien, seulement « inner »
 *   bash -c 'sleep 50 & jobs'                          -> « [1]+  Running  sleep 50 & » (il recommence a 1)
 *   ... puis `jobs` dans le shell parent               -> seulement « [1]+  Running  sleep 100 & »
 * Le simulateur n'avait qu'UN tableau par machine : l'enfant voyait les jobs du parent, numerotait ses propres jobs
 * a la suite ([2]) et les laissait dans le tableau du parent (TODO.md [ps]). Corrige : un `bash -c`, `bash fichier` ou
 * script donne a l'enfant un tableau neuf, rendu au parent a sa sortie. Les sous-shells `( )` et `$( )` gardent celui du
 * parent, comme le vrai bash (verifie : ils listent les jobs du parent).
 *
 * Discrimine par `git stash` sur src/network : 4 des 5 cas tombent avant. TEMOIN : le parent liste son job, et le
 * sous-shell `( )` voit les jobs du parent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<(command: string) => Promise<string>> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const run = async (command: string): Promise<string> => String(await pc.executeCommand(command)).trim();
  await run('sleep 100 &');
  return run;
}

describe('the job table belongs to one shell', () => {
  it('WITNESS — the parent lists its job, and a subshell sees the parent jobs', async () => {
    const run = await lab();
    expect(await run('jobs')).toMatch(/^\[1\]\+\s+Running\s+sleep 100 &$/);
    expect(await run('(jobs; echo sub)')).toMatch(/^\[1\]\+\s+Running\s+sleep 100 &\nsub$/);
  });

  it('a child bash starts with an empty table', async () => {
    const run = await lab();
    expect(await run('bash -c "jobs; echo inner"')).toBe('inner');
  });

  it('a child bash numbers its own jobs from 1', async () => {
    const run = await lab();
    expect(await run('bash -c "sleep 50 & jobs"')).toMatch(/\[1\]\+\s+Running\s+sleep 50 &$/);
  });

  it('the jobs of a child bash do not leak into the parent', async () => {
    const run = await lab();
    await run('bash -c "sleep 50 & jobs"');
    expect(await run('jobs')).toMatch(/^\[1\]\+\s+Running\s+sleep 100 &$/);
  });

  it('the parent table is unchanged after a child script ran', async () => {
    const run = await lab();
    await run("printf 'sleep 30 &\\njobs\\n' > /tmp/j.sh");
    expect(await run('bash /tmp/j.sh')).toMatch(/\[1\]\+\s+Running\s+sleep 30 &$/);
    expect(await run('jobs')).toMatch(/^\[1\]\+\s+Running\s+sleep 100 &$/);
  });
});
