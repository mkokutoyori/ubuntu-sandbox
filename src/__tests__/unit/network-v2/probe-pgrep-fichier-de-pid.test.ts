/**
 * `pgrep|pkill -F fichier` (procps-ng 4.0.4) lit le pid d'un fichier de pid et restreint la selection a ce processus, en
 * plus des autres criteres. Releve sur la machine de reference (procps-ng 4.0.4) :
 *   pgrep -F pf.pid                 -> le pid, rc 0          pgrep -l -F pf.pid -> "pid comm"
 *   pgrep -x sleep -F pf.pid        -> rien, rc 1 quand le processus du fichier ne s'appelle pas ainsi
 *   pgrep -c -F pf.pid sur un mort  -> 0, rc 1                pgrep -F <pid mort> -> rien, rc 1
 *   fichier absent | vide | sans entier -> « pgrep: pidfile not valid » + « Try `pgrep --help' for more information. », rc 1
 *   pkill -F pf.pid                 -> tue le processus, rc 0
 * Le simulateur refusait TOUJOURS `-F` comme un fichier invalide (TODO.md [ps]). Corrige : le contexte de commande lit le
 * fichier de la machine (chemin relatif au repertoire courant du shell) et le pid du fichier filtre les candidats.
 *
 * Discrimine par `git stash` sur src/network : 5 des 8 cas tombent avant. TEMOINS : les trois refus (absent, vide, sans
 * entier), deja corrects parce que tout `-F` etait refuse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<{ pc: LinuxPC; run: (command: string) => Promise<string> }> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const run = async (command: string): Promise<string> => String(await pc.executeCommand(command)).trim();
  await run('sleep 300 &');
  return { pc, run };
}

const withPidfile = async (run: (c: string) => Promise<string>): Promise<string> => {
  const pid = await run('pgrep -x sleep');
  await run(`echo ${pid} > /tmp/pf.pid`);
  return pid;
};

describe('pgrep -F', () => {
  it('prints the pid the file holds', async () => {
    const { run } = await lab();
    const pid = await withPidfile(run);
    expect(await run('pgrep -F /tmp/pf.pid')).toBe(pid);
  });

  it('-l adds the name', async () => {
    const { run } = await lab();
    const pid = await withPidfile(run);
    expect(await run('pgrep -l -F /tmp/pf.pid')).toBe(`${pid} sleep`);
  });

  it('another criterion must also match', async () => {
    const { run } = await lab();
    await withPidfile(run);
    expect(await run('pgrep -x nomatch -F /tmp/pf.pid; echo rc=$?')).toBe('rc=1');
    expect(await run('pgrep -x sleep -F /tmp/pf.pid; echo rc=$?')).toMatch(/rc=0$/);
  });

  it('a pid that is not running selects nothing', async () => {
    const { run } = await lab();
    await run('echo 999999 > /tmp/dead.pid');
    expect(await run('pgrep -F /tmp/dead.pid; echo rc=$?')).toBe('rc=1');
  });

  it('pkill -F kills the process of the file', async () => {
    const { run } = await lab();
    await withPidfile(run);
    expect(await run('pkill -F /tmp/pf.pid; echo rc=$?')).toBe('rc=0');
    expect(await run('pgrep -x sleep; echo rc=$?')).toBe('rc=1');
  });

  it.each([
    ['a missing file', 'pgrep -F /tmp/absent.pid'],
    ['an empty file', ': > /tmp/empty.pid; pgrep -F /tmp/empty.pid'],
    ['a file without an integer', 'echo abc > /tmp/g.pid; pgrep -F /tmp/g.pid'],
  ])('%s is a pidfile not valid', async (_name, command) => {
    const { run } = await lab();
    const out = await run(`${command}; echo rc=$?`);
    expect(out).toContain('pgrep: pidfile not valid');
    expect(out).toMatch(/rc=1$/);
  });
});
