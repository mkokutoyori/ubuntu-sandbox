/**
 * Un `stty` qui est le vrai, rejoue contre le vrai : coreutils 9.4 sur de vrais ptys
 * (scripts/oracle/record_stty.py, `os.openpty()`, glibc 2.39, noyau 6.18).  Chaque scenario ouvre un pty
 * neuf (24x80 sauf mention, `iutf8` comme un emulateur de terminal ou sshd le laissent), joue des invocations
 * de `stty` et relit apres chacune l'etat par `stty`, `stty -a` et `stty -g` : une divergence sur ce qu'un pas
 * a CHANGE se voit meme quand il n'a rien affiche.  890 scenarios, 4164 pas : affichage a sept tailles, les
 * styles de sortie et la ligne de commande a deux passes de getopt_long, chaque mode et son inverse, les modes
 * combines, chaque caractere de controle avec 27 valeurs, min/time avec plus de quarante formes d entier, les 34 vitesses,
 * ispeed/ospeed, rows/cols/size, `line`, les chaines de `-g`, la normalisation du pty (CS8/CREAD forces, PARENB
 * et ADDRB refuses, EINVAL de glibc), `-F`, l'absence de tty, le quoting gnulib des noms de peripherique, et
 * 760 suites aleatoires d'un a six pas.
 *
 * Mesure avec `git stash push -- src/network` : les 890 tombent, parce que le `runStty` d'avant ne prenait ni
 * hote (entree standard, `-F`, largeur) ni etat termios ; ce test-ci ne discrimine donc pas a lui seul, c'est
 * probe-stty-etat-termios-du-tty (11 cas sur 12 tombent) qui le fait au niveau du simulateur.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runStty, type SttyHost } from '@/network/devices/linux/tty/Stty';
import { TtyDevice } from '@/network/devices/linux/tty/TtyDevice';

interface RecordedStep {
  args: string[];
  stdin: 'tty' | 'null';
  columns: number;
  stdout: string;
  stderr: string;
  code: number;
  state: Record<string, string>;
}

interface RecordedScenario {
  name: string;
  rows: number;
  cols: number;
  probe: string[];
  initial: Record<string, string>;
  steps: RecordedStep[];
}

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/tty/stty-termios.json', 'utf8')) as {
  scenarios: RecordedScenario[];
};

const SLAVE = '/dev/pts/9';
const NOT_TTY = new Set(['/dev/null', '/etc/passwd', '/tmp']);

function hostFor(device: TtyDevice, stdin: 'tty' | 'null', columns: number): SttyHost {
  return {
    standardInput: stdin === 'tty' ? device : null,
    columns: columns > 0 ? columns : 80,
    openDevice: (path) => {
      if (path === SLAVE) return device;
      return { errno: NOT_TTY.has(path) ? 'ENOTTY' : 'ENOENT' };
    },
  };
}

function normalise(text: string): string {
  return text.split(SLAVE).join('{tty}');
}

function stateOf(device: TtyDevice, kinds: readonly string[], columns: number): Record<string, string> {
  const flag: Record<string, string[]> = { plain: [], a: ['-a'], g: ['-g'] };
  const state: Record<string, string> = {};
  for (const kind of kinds) {
    const result = runStty(flag[kind], hostFor(device, 'tty', columns));
    state[kind] = result.exitCode === 0 ? result.stdout : `ERR:${result.stderr}`;
  }
  return state;
}

describe('stty replays a real stty 9.4 on real ptys', () => {
  for (const scenario of recorded.scenarios) {
    it(scenario.name, () => {
      const device = new TtyDevice();
      device.windowSize = { rows: scenario.rows, cols: scenario.cols };
      expect(stateOf(device, scenario.probe, scenario.cols)).toEqual(scenario.initial);
      scenario.steps.forEach((step, index) => {
        const args = step.args.map((arg) => arg.split('{tty}').join(SLAVE));
        const result = runStty(args, hostFor(device, step.stdin, step.columns));
        const label = `${scenario.name} #${index} ${JSON.stringify(step.args)}`;
        expect([label, normalise(result.stdout), normalise(result.stderr), result.exitCode])
          .toEqual([label, step.stdout, step.stderr, step.code]);
        expect([label, stateOf(device, scenario.probe, device.windowSize.cols)]).toEqual([label, step.state]);
      });
    });
  }
});
