/**
 * `pgrep|pkill -r etats` (procps-ng 4.0.4) ne retient que les processus dont l'etat est l'une des lettres donnees. L'option
 * etait acceptee avec sa valeur puis ignoree (regle 6 : `pgrep -r Z` listait tout). Releve sur la machine de reference :
 *   pgrep -r S -c  -> les processus endormis        pgrep -r Z -c -> 0        pgrep -r '' -> rien, rc 1
 *   pgrep -r s -c  -> 0 (casse significative)       pgrep -r 'S R' -c -> comme SR (seules les lettres comptent)
 *   pgrep --runstates=S -c  -> comme -r S           -r seul est un critere (pas de « no matching criteria »)
 * Corrige : la selection garde les processus dont `state` est dans l'ensemble.
 *
 * Discrimine par `git stash` sur src/network : 5 des 6 cas tombent avant (la forme longue `--runstates` n'existait pas non
 * plus). TEMOIN : -r S (un `sleep` est endormi, tout le monde passait).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<(command: string) => Promise<string>> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const run = async (command: string): Promise<string> => String(await pc.executeCommand(command)).trim();
  await run('sleep 300 &');
  return run;
}

describe('pgrep -r', () => {
  it('WITNESS — -r S keeps a sleeping process', async () => {
    const run = await lab();
    expect(await run('pgrep -r S -x sleep; echo rc=$?')).toMatch(/^\d+\nrc=0$/);
  });

  it('a state the process is not in selects nothing', async () => {
    const run = await lab();
    expect(await run('pgrep -r R -x sleep; echo rc=$?')).toBe('rc=1');
    expect(await run('pgrep -r Z -c; echo rc=$?')).toBe('0\nrc=1');
  });

  it('the letters are case sensitive', async () => {
    const run = await lab();
    expect(await run('pgrep -r s -c -x sleep; echo rc=$?')).toBe('0\nrc=1');
  });

  it('an empty list selects nothing and is itself a criterion', async () => {
    const run = await lab();
    expect(await run("pgrep -r ''; echo rc=$?")).toBe('rc=1');
  });

  it('only the letters count: "S R" is "SR"', async () => {
    const run = await lab();
    expect(await run("pgrep -r 'S R' -x sleep; echo rc=$?")).toMatch(/^\d+\nrc=0$/);
    expect(await run('pgrep -r R -x sleep; echo rc=$?')).toBe('rc=1');
  });

  it('WITNESS — the long form behaves like -r', async () => {
    const run = await lab();
    expect(await run('pgrep --runstates=Z -x sleep; echo rc=$?')).toBe('rc=1');
    expect(await run('pgrep --runstates=S -x sleep; echo rc=$?')).toMatch(/^\d+\nrc=0$/);
  });
});
