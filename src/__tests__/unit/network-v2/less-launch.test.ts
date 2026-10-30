import { describe, it, expect } from 'vitest';
import { parseLessLaunch } from '@/network/devices/linux/editors/lessLaunch';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('less launch', () => {
  it('reads files, flags and initial commands', () => {
    const r = parseLessLaunch('sudo less -N -S +G a.txt b.txt');
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    expect(r.launch.files).toEqual(['a.txt', 'b.txt']);
    expect(r.launch.options.lineNumbers).toBe(true);
    expect(r.launch.options.chopLongLines).toBe(true);
    expect(r.launch.initialKeys).toBe('G');
  });

  it('opens a pager on the output of a pipeline and refuses an unknown option in less words', () => {
    const piped = parseLessLaunch('ls -l /etc | grep conf | less');
    expect(piped.kind === 'open' && piped.launch.prefix).toBe('ls -l /etc | grep conf');
    expect(parseLessLaunch('less -Z x')).toEqual({ kind: 'error', message: 'There is no Z option ("less --help" for help)' });
  });

  it('answers --help with the help screen and -V with the version text', () => {
    const help = parseLessLaunch('less --help');
    expect(help.kind === 'open' && help.launch.help).toBe(true);
    expect(help.kind === 'open' && help.launch.files).toEqual([]);
    const version = parseLessLaunch('less -V');
    expect(version.kind === 'print' && version.lines[0]).toBe('less 590 (GNU regular expressions)');
    expect(parseLessLaunch('less --nonesuch')).toEqual({ kind: 'error', message: 'There is no --nonesuch option ("less --help" for help)' });
  });

  it('leaves redirections and other commands to the shell', () => {
    expect(parseLessLaunch('less a > b').kind).toBe('none');
    expect(parseLessLaunch('cat a').kind).toBe('none');
  });

  it('prints like cat when there is no terminal', async () => {
    const s = new LinuxServer('linux-server', 'S');
    expect(await s.executeCommand('printf "x\\ny\\n" > /tmp/a; less /tmp/a; echo z | less; less /nope')).toBe('x\ny\nz\n/nope: No such file or directory');
  });
});
