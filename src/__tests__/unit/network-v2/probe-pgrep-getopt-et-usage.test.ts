/**
 * `pgrep`/`pkill` d'un procps-ng 4.0.4 passent leurs arguments par getopt_long (src/pgrep.c, lu sur
 * raw.githubusercontent.com/procps-ng/procps v4.0.4) : une option inconnue, ambigue (prefixe commun a plusieurs options
 * longues), sans son argument, ou avec un argument refuse, sort en 2 avec le diagnostic de getopt puis le texte d'usage ;
 * `-h` imprime l'usage sur la sortie standard ; deux motifs sont refuses ; -n, -o et -v s'excluent ; `-L` sans `-F` est
 * refuse ; `-i` repete imprime l'usage et sort en 0 ; `-A` exclut les ancetres ; `pkill -e` ecrit « <nom> killed (pid N) »
 * et `pkill -c` le nombre de processus. Le simulateur ignorait en silence toute option longue inconnue et traitait toute
 * option longue reconnue mais jamais lue : -A, -e, -L, -h, `pkill -c` (regle 6). GnuOptionGuard (table d'options, usage) existait deja ;
 * il lui manquait l'ambiguite des prefixes (`--c`, `--n`, `--l`), maintenant dans commands/Getopt, et l'ordre exact de la table longue
 * de pgrep.c. Les textes sont releves tels quels sur la machine de reference.
 *
 * Discrimine par `git stash` sur src/network : 8 des 16 cas tombent avant. TEMOINS : un motif seul reste trouve ; les options inconnues, -d et
 * --cgroup sans valeur, --count=3 et l'usage de pkill etaient deja refuses par GnuOptionGuard ; `pkill -e` sans cible ne tue rien.
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

const head = (lines: number) => ` 2>&1 | head -${lines}`;

describe('pgrep getopt diagnostics', () => {
  it('WITNESS — a lone pattern still finds the sleep', async () => {
    const run = await lab();
    expect(await run('pgrep -x sleep; echo rc=$?')).toMatch(/^\d+\nrc=0$/);
  });

  it.each([
    ['-z', "pgrep: invalid option -- 'z'"],
    ['--bogus', "pgrep: unrecognized option '--bogus'"],
    ['--c', "pgrep: option '--c' is ambiguous; possibilities: '--count' '--cgroup'"],
    ['--n', "pgrep: option '--n' is ambiguous; possibilities: '--newest' '--ns' '--nslist'"],
    ['--count=3', "pgrep: option '--count' doesn't allow an argument"],
    ['-d', "pgrep: option requires an argument -- 'd'"],
    ['--cgroup', "pgrep: option '--cgroup' requires an argument"],
  ])('%s is refused by getopt, then the usage follows', async (option, diagnostic) => {
    const run = await lab();
    expect(await run(`pgrep ${option}${head(4)}`)).toBe(`${diagnostic}\n\nUsage:\n pgrep [options] <pattern>`);
    expect(await run(`pgrep ${option} >/dev/null 2>&1; echo rc=$?`)).toBe('rc=2');
  });

  it('pkill prints its own usage', async () => {
    const run = await lab();
    expect(await run(`pkill --bogus${head(4)}`)).toBe("pkill: unrecognized option '--bogus'\n\nUsage:\n pkill [options] <pattern>");
    expect(await run('pkill --bogus 2>&1 | grep -c "signal to send"')).toBe('2');
  });

  it('-h prints the usage on standard output and succeeds', async () => {
    const run = await lab();
    expect(await run('pgrep -h 2>/dev/null | head -3; pgrep -h >/dev/null; echo rc=$?')).toBe('Usage:\n pgrep [options] <pattern>\nrc=0');
  });

  it('two patterns, -L without -F, -n with -o', async () => {
    const run = await lab();
    expect(await run('pgrep a b 2>&1; echo rc=$?')).toBe("pgrep: only one pattern can be provided\nTry `pgrep --help' for more information.\nrc=2");
    expect(await run('pgrep -L x 2>&1; echo rc=$?')).toBe("pgrep: -L without -F makes no sense\nTry `pgrep --help' for more information.\nrc=2");
    expect(await run(`pgrep -n -o x${head(3)}`)).toBe('Usage:\n pgrep [options] <pattern>');
  });

  it('-i given twice prints the usage and succeeds', async () => {
    const run = await lab();
    expect(await run('pgrep -i -i x 2>/dev/null | head -2; pgrep -i -i x >/dev/null 2>&1; echo rc=$?')).toBe('Usage:\nrc=0');
  });

  it('-A leaves out the ancestors of the command', async () => {
    const run = await lab();
    const name = await run('ps -o comm= -p $PPID');
    const all = Number(await run(`pgrep -c -x ${name}`));
    expect(all).toBeGreaterThan(0);
    expect(Number(await run(`pgrep -A -c -x ${name}`))).toBe(all - 1);
  });
});

describe('pkill output options', () => {
  it('-e names what it kills', async () => {
    const run = await lab();
    expect(await run('pkill -e -x sleep; echo rc=$?')).toMatch(/^sleep killed \(pid \d+\)\nrc=0$/);
  });

  it('-c counts what it killed', async () => {
    const run = await lab();
    expect(await run('pkill -c -x sleep; echo rc=$?')).toBe('1\nrc=0');
  });

  it('-e without pattern names nothing', async () => {
    const run = await lab();
    expect(await run('pkill -e -P 1 -x nosuch; echo rc=$?')).toBe('rc=1');
  });
});
