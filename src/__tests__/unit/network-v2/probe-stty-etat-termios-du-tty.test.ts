/**
 * Un tty a des reglages termios, et `stty` les lit et les ecrit : ce que le simulateur acceptait sans effet
 * (`stty -echo`, `stty sane`, `stty raw`, `stty erase ^H`, `stty foo`) est desormais applique a l etat du tty
 * de la session, relu par `stty`, `stty -a` et `stty -g`.  Les chaines `-g` attendues sont celles du vrai stty
 * 9.4 sur un vrai pty (src/__tests__/support/oracle/tty/stty-termios.json, rejoue en entier par
 * stty-oracle.test.ts) ; ici on verifie que le SIMULATEUR les atteint : deux ttys qui ne se melangent pas,
 * `-F /dev/pts/N` qui joint l'autre tty, un pipe ou un `ssh` sans pty qui n'a pas de tty a interroger, une
 * largeur de ligne qui est la fenetre sur un terminal et 80 sur un pipe.
 *
 * Mesure avec `git stash push -- src/network` : 11 cas sur 12 tombent avant.  Le douzieme passe des deux
 * cotes : TEMOIN, `stty size` repondait deja `24 80`, ce qui prouve que le lab (deux sessions d'un meme PC)
 * interroge bien un tty.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

interface RecordedStep { args: string[]; state: Record<string, string> }
interface RecordedScenario { name: string; initial: Record<string, string>; steps: RecordedStep[] }
const recorded = (JSON.parse(readFileSync('src/__tests__/support/oracle/tty/stty-termios.json', 'utf8')) as {
  scenarios: RecordedScenario[];
}).scenarios;

function stateAfter(scenarioName: string, args: string[]): string {
  const scenario = recorded.find((candidate) => candidate.name === scenarioName) as RecordedScenario;
  const step = scenario.steps.find((candidate) => JSON.stringify(candidate.args) === JSON.stringify(args)) as RecordedStep;
  return step.state.g.trim();
}

const BASELINE = (recorded[0] as RecordedScenario).initial.g.trim();

async function lab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const first = pc.openShellSession();
  const second = pc.openShellSession();
  const run = async (command: string, session = first) => (await pc.executeCommandInSession(command, session)).replace(/\n$/, '');
  return { pc, first, second, run };
}

describe('a tty has termios settings that stty reads and writes', () => {
  it('a fresh login tty carries the settings a terminal emulator leaves', async () => {
    const { run } = await lab();
    expect(await run('stty -g')).toBe(BASELINE);
  });

  it('stty -echo changes the one bit stty -g shows, and stty without argument lists it', async () => {
    const { run } = await lab();
    await run('stty -echo');
    expect(await run('stty -g')).toBe(stateAfter('mode-echo', ['-echo']));
    expect(await run('stty')).toBe('speed 38400 baud; line = 0;\n-brkint -imaxbel iutf8\n-echo');
  });

  it('raw then sane land on the settings of the real stty', async () => {
    const { run } = await lab();
    await run('stty raw');
    expect(await run('stty -g')).toBe(stateAfter('mode-raw', ['raw']));
    await run('stty sane');
    expect(await run('stty -g')).toBe(stateAfter('mode-raw', ['sane']));
  });

  it('a word that is not a setting is refused in stty\'s words, and nothing before it is applied', async () => {
    const { run } = await lab();
    expect(await run('stty -echo foo; echo rc=$?')).toBe("stty: invalid argument 'foo'\nTry 'stty --help' for more information.\nrc=1");
    expect(await run('stty -g')).toBe(BASELINE);
  });

  it('a control character is set, shown, and refused when it is out of range', async () => {
    const { run } = await lab();
    await run('stty intr ^X erase ^H');
    expect(await run('stty')).toContain('intr = ^X; erase = ^H;');
    expect(await run('stty min 300; echo rc=$?')).toBe("stty: invalid integer argument: '300': Numerical result out of range\nrc=1");
  });

  it('the settings of one tty are not those of the other', async () => {
    const { run, second } = await lab();
    await run('stty -echo -icanon');
    expect(await run('stty -g', second)).toBe(BASELINE);
    expect(await run('stty -g')).not.toBe(BASELINE);
  });

  it('-F reaches the other tty by its device name, settings and size alike', async () => {
    const { run, second } = await lab();
    expect(await run('tty')).toBe('/dev/pts/0');
    expect(await run('tty', second)).toBe('/dev/pts/1');
    await run('stty -F /dev/pts/1 rows 10 cols 30 -echo');
    expect(await run('stty size', second)).toBe('10 30');
    expect(await run('stty -g', second)).toBe(stateAfter('mode-echo', ['-echo']));
    expect(await run('stty size')).toBe('24 80');
  });

  it('-F with a name that is no tty answers in the words of open(2) and ioctl(2)', async () => {
    const { run } = await lab();
    expect(await run('stty -F /nonexistent; echo rc=$?')).toBe('stty: /nonexistent: No such file or directory\nrc=1');
    expect(await run('stty -F /dev/null; echo rc=$?')).toBe('stty: /dev/null: Inappropriate ioctl for device\nrc=1');
    expect(await run('stty -F $(tty) -g')).toBe(BASELINE);
  });

  it('a pipe is no tty: stty on a pipe or a redirected file is refused', async () => {
    const { run } = await lab();
    expect(await run('echo x | stty -a; echo rc=$?')).toBe("stty: 'standard input': Inappropriate ioctl for device\nrc=1");
    expect(await run('stty -g < /dev/null; echo rc=$?')).toBe("stty: 'standard input': Inappropriate ioctl for device\nrc=1");
  });

  it('the line width of stty -a is the window on a terminal and 80 on a pipe', async () => {
    const { run, first } = await lab();
    first.windowSize = { rows: 24, cols: 40 };
    const widest = (text: string) => Math.max(...text.split('\n').map((line) => line.length));
    expect(widest(await run('stty -a'))).toBeLessThanOrEqual(40);
    const piped = widest(await run('stty -a | cat'));
    expect(piped).toBeGreaterThan(70);
    expect(piped).toBeLessThanOrEqual(80);
  });

  it('TEMOIN : the lab itself answers stty size', async () => {
    const { run } = await lab();
    expect(await run('stty size')).toBe('24 80');
  });
});

describe('over SSH, a command without a pty has no tty to ask', () => {
  it('ssh host stty answers as stty does on a pipe, ssh -t as on a terminal', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('linux-server', 'SRV1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.18.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].configureIP(new IPAddress('10.0.18.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);
    const session = pc.openShellSession();
    const ssh = 'sshpass -p alice ssh -o StrictHostKeyChecking=no';
    const without = await pc.executeCommandInSession(`${ssh} alice@10.0.18.2 'stty -g; echo rc=$?'`, session);
    expect(without).toContain("stty: 'standard input': Inappropriate ioctl for device");
    const withTty = await pc.executeCommandInSession(`${ssh} -t alice@10.0.18.2 'stty -g'`, session);
    expect(withTty).toContain(BASELINE);
  }, 30000);
});
