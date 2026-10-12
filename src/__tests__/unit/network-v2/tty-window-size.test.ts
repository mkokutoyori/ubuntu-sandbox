/**
 * Un tty a UNE taille de fenetre, et tout ce qui la lit la lit au meme endroit : `stty size`,
 * `stty -a`, `tput cols`, `tput lines`, `$COLUMNS` et `$LINES` d'un shell, l'editeur plein
 * ecran.  Le rejeu compare, pour six tailles, la sortie d'un vrai bash 5.2 et de stty 9.4 sur un
 * vrai pty (scripts/oracle/record_tty_geometry.py, tmux) a celle du shell simule ; `$COLUMNS` et
 * `$LINES` y sont des variables du shell, absentes de l'environnement des enfants.  Les cas
 * suivants fixent la taille par `stty rows R cols C`, par le terminal local, par un
 * `window-change` SSH, et verifient que `ssh -t` la transmet.
 *
 * Mesure avec `git stash push -u -- src/network src/terminal src/bash src/components` : 17 cas
 * sur 20 tombent avant (`stty` ne connaissait que COLUMNS/LINES dans l'environnement, `-a`
 * repondait deux nombres, `tput` ne repondait rien, la session n'avait pas de taille).  Les trois
 * autres passent des deux cotes : TEMOIN, `env | grep -c ^COLUMNS=` rend 0 (le lab lit bien
 * l'environnement) ; TEMOIN, un terminal sans taille garde 24x80 ; NON-REGRESSION, le shell
 * distant ouvert par `pty-req` 24x80 repondait deja `24 80`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { RemoteVimController } from '@/terminal/editors/RemoteEditorController';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

interface RecordedSize { rows: number; cols: number; probes: Record<string, string[]> }
const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/tty/tty-geometry.json', 'utf8')) as { sizes: RecordedSize[] };

async function run(pc: LinuxPC, command: string, rows: number, cols: number): Promise<string> {
  const session = pc.openShellSession();
  session.windowSize = { rows, cols };
  return (await pc.executeCommandInSession(command, session)).replace(/\n$/, '');
}

describe('a real bash on a real pty and the simulated shell report the same window', () => {
  for (const size of recorded.sizes) {
    it(`${size.rows}x${size.cols}`, async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      for (const [probe, lines] of Object.entries(size.probes)) {
        expect([probe, await run(pc, probe, size.rows, size.cols)]).toEqual([probe, lines.join('\n')]);
      }
    });
  }
});

describe('the size is the tty\'s, set by stty and read back everywhere', () => {
  it('stty rows R cols C is seen by stty size, tput and $COLUMNS in the next commands', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = pc.openShellSession();
    await pc.executeCommandInSession('stty rows 40 cols 120', session);
    expect((await pc.executeCommandInSession('stty size', session)).trim()).toBe('40 120');
    expect((await pc.executeCommandInSession('tput cols; tput lines', session)).trim()).toBe('120\n40');
    expect((await pc.executeCommandInSession('echo "[$COLUMNS][$LINES]"', session)).trim()).toBe('[120][40]');
  });

  it('stty size prints the size from before the cols that follows it on the same line', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = pc.openShellSession();
    expect((await pc.executeCommandInSession('stty size cols 100; stty size', session)).trim()).toBe('24 80\n24 100');
  });

  it.each([
    ['stty rows abc', "stty: invalid integer argument: 'abc'"],
    ['stty cols', "stty: missing argument to 'cols'\nTry 'stty --help' for more information."],
  ])('%s is refused in stty\'s words', async (command, message) => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await run(pc, command, 24, 80);
    expect(out).toBe(message);
  });

  it('tput refuses an unknown capability with status 4', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await run(pc, "tput bogus; echo rc=$?", 24, 80)).toBe("tput: unknown terminfo capability 'bogus'\nrc=4");
  });

  it('TEMOIN : COLUMNS and LINES are shell variables, not part of the exported environment', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await run(pc, "env | grep -c '^COLUMNS=\\|^LINES='", 24, 80)).toBe('0');
  });

  it('two sessions on one machine keep their own size', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const a = pc.openShellSession();
    const b = pc.openShellSession();
    a.windowSize = { rows: 50, cols: 200 };
    b.windowSize = { rows: 10, cols: 40 };
    expect((await pc.executeCommandInSession('stty size', a)).trim()).toBe('50 200');
    expect((await pc.executeCommandInSession('stty size', b)).trim()).toBe('10 40');
  });
});

describe('the local terminal hands its size to its shell', () => {
  it('setWindowSize on the session is what stty size answers', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const term = new LinuxTerminalSession('t1', pc);
    await term.init?.();
    term.setWindowSize(30, 100);
    term.setInputBuf('stty size');
    term.handleKey({ key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as never);
    for (let i = 0; i < 40; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
    expect(term.lines.map((l) => l.text).join('\n')).toContain('30 100');
  });

  it('TEMOIN : a terminal that was never told its size keeps 80 columns', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const term = new LinuxTerminalSession('t1', pc);
    await term.init?.();
    term.setInputBuf('stty size');
    term.handleKey({ key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as never);
    for (let i = 0; i < 40; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
    expect(term.lines.map((l) => l.text).join('\n')).toContain('24 80');
  });
});

describe('over SSH the size travels as pty-req and window-change', () => {
  it('the remote shell starts with the 24x80 of the pty-req', async () => {
    const { channel } = await wireShellChannel();
    expect(((await channel.runLine('stty size')) as { stdout: string }).stdout.trim()).toBe('24 80');
  }, 30000);

  it('a window-change reaches the remote tty before the next command', async () => {
    const { channel } = await wireShellChannel();
    channel.resize(132, 50);
    const answer = await channel.runLine('stty size; tput cols; echo "[$COLUMNS][$LINES]"') as { stdout: string };
    expect(answer.stdout.trim()).toBe('50 132\n132\n[132][50]');
  }, 30000);

  it('the same window-change resizes the open editor and the remote tty alike', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/tw.txt`);
    await channel.openEditor('vim /tmp/tw.txt');
    channel.resize(60, 12);
    const answer = await channel.runLine('stty size') as { stdout: string };
    expect(answer.stdout.trim()).toBe('12 60');
  }, 30000);

  it('ssh -t forwards the client tty size as COLUMNS and LINES', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('linux-server', 'SRV1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.17.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].configureIP(new IPAddress('10.0.17.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);
    const session = pc.openShellSession();
    session.windowSize = { rows: 33, cols: 111 };
    const out = await pc.executeCommandInSession(
      "sshpass -p alice ssh -o StrictHostKeyChecking=no -t alice@10.0.17.2 'echo $COLUMNS:$LINES'", session);
    expect(out).toContain('111:33');
  }, 30000);

  it('a terminal session hands a new size to its SSH hop, and the hop\'s editor opens at it', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('linux-server', 'SRV1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.16.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].configureIP(new IPAddress('10.0.16.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);
    const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); } };
    const key = (k: string) => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as never;
    const term = new LinuxTerminalSession('t1', pc);
    await term.init?.();
    term.setWindowSize(30, 100);
    term.setInput('ssh -o StrictHostKeyChecking=accept-new alice@10.0.16.2');
    term.handleKey(key('Enter'));
    for (let i = 0; i < 60 && term.currentInputMode.type !== 'password'; i++) await flush();
    term.setPasswordBuf('alice');
    term.handleKey(key('Enter'));
    await flush();

    term.setInputBuf('stty size');
    term.handleKey(key('Enter'));
    await flush();
    expect(term.lines.map((l) => l.text).join('\n')).toContain('30 100');

    term.setWindowSize(20, 70);
    await flush();
    term.setInputBuf('vim /tmp/tw2.txt');
    term.handleKey(key('Enter'));
    await flush();
    const controller = (term.currentInputMode as { controller: RemoteVimController }).controller;
    expect(controller.screen.rows.length).toBe(20);
    controller.resize(15, 70);
    await flush();
    expect(controller.screen.rows.length).toBe(15);
  }, 60000);
});
