/**
 * `pgrep --ns PID`, `--nslist` et `--cgroup` (procps-ng 4.0.4, src/pgrep.c lu sur raw.githubusercontent.com/procps-ng/procps
 * v4.0.4 et mesures sur la machine de reference). Les trois options etaient SILENCIEUSEMENT IGNOREES (option longue inconnue :
 * `continue`) et leur valeur devenait le motif : `pgrep --ns 1` cherchait « 1 » (regle 6). Portage fidele :
 *   --ns PID      garde les processus dont les espaces de noms retenus egalent ceux de PID ; atoi(PID) == 0 (« abc », « 0 ») ne
 *                 pose PAS de reference : le source de 4.0.4 laisse alors le `case 'r'` suivant l'executer, donc la valeur
 *                 devient la liste d'etats de -r (pgrep --ns abc : rc 1, rien) ; une reference qui n'existe pas lit des
 *                 espaces tous a 0, que personne ne partage
 *   --nslist l    noms parmi cgroup ipc mnt net pid time user uts ; un nom inconnu : sortie 2 SANS message ; seul le DERNIER nom
 *                 de la liste compte (conv_ns remet ns_flags a 0 a chaque element) ; defaut 0x3f = cgroup ipc mnt net pid time
 *   --cgroup l    garde les processus dont `0::<chemin>` de /proc/<pid>/cgroup est l'un des chemins (egalite stricte) ;
 *                 compte comme critere
 * Tous les processus du simulateur partagent les espaces de noms de l'hote (ProcessTaskBuilder.NAMESPACE_IDS).
 *
 * Discrimine par `git stash` sur src/network : 5 des 7 cas tombent avant. TEMOINS : -w seul n'est pas un critere et un sleep est
 * trouve par son nom ; « --ns d'un processus absent » passe aussi avant, par accident (la valeur devenait le motif).
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

describe('pgrep --ns / --nslist / --cgroup', () => {
  it('WITNESS — a sleep is found by name and -w alone is no criterion', async () => {
    const run = await lab();
    expect(await run('pgrep -x sleep; echo rc=$?')).toMatch(/^\d+\nrc=0$/);
    expect(await run('pgrep -w; echo rc=$?')).toContain('no matching criteria specified');
  });

  it('--ns of a live process selects the processes sharing its namespaces', async () => {
    const run = await lab();
    expect(await run('pgrep --ns $$ -x sleep; echo rc=$?')).toMatch(/^\d+\nrc=0$/);
  });

  it('--ns of a process that does not exist shares nothing', async () => {
    const run = await lab();
    expect(await run('pgrep --ns 99999999 -x sleep; echo rc=$?')).toBe('rc=1');
  });

  it('--ns with a value atoi turns into 0 becomes the run states of -r', async () => {
    const run = await lab();
    expect(await run('pgrep --ns abc -x sleep; echo rc=$?')).toBe('rc=1');
    expect(await run('pgrep --ns S -x sleep; echo rc=$?')).toMatch(/^\d+\nrc=0$/);
  });

  it('--nslist refuses an unknown namespace with status 2 and no message', async () => {
    const run = await lab();
    expect(await run('pgrep --nslist foo --ns $$ -x sleep; echo rc=$?')).toBe('rc=2');
    expect(await run('pgrep --nslist ipc,foo --ns $$ -x sleep; echo rc=$?')).toBe('rc=2');
  });

  it('--nslist accepts the namespace names', async () => {
    const run = await lab();
    expect(await run('pgrep --nslist user --ns $$ -x sleep; echo rc=$?')).toMatch(/^\d+\nrc=0$/);
  });

  it('--cgroup keeps the processes of that cgroup path and counts as a criterion', async () => {
    const run = await lab();
    const pid = await run('pgrep -x sleep');
    const path = (await run(`cat /proc/${pid}/cgroup`)).replace(/^0::/, '');
    expect(await run(`pgrep --cgroup ${path} -x sleep; echo rc=$?`)).toMatch(/^\d+\nrc=0$/);
    expect(await run(`pgrep --cgroup ${path},/nope -x sleep; echo rc=$?`)).toMatch(/^\d+\nrc=0$/);
    expect(await run('pgrep --cgroup /nope; echo rc=$?')).toBe('rc=1');
  });
});
