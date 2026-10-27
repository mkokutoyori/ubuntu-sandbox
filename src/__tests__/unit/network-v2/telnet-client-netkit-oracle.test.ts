/*
 * Oracle: the Ubuntu 22.04 `telnet` (netkit-telnet 0.17-44build1) run under a pty by scripts/oracle/record_telnet_client.py, recorded
 * in src/__tests__/support/oracle/telnet-client-netkit.json. Four families: the client alone at its `telnet>` prompt (12 scripts, 144
 * typed lines), the command line (34 argument vectors), 51 sessions against a scripted TCP server and 10 runs with a pipe on standard input (what the terminal showed and
 * what the server received, step by step). PtyDiscipline in support/telnet plays the kernel's line discipline (ICANON, ECHO, ECHOCTL,
 * ICRNL, ISIG, VEOL = the escape character), so the engine is compared on what a person sees, not on a transcript it was shaped to.
 *
 * Before NetkitTelnetClient existed all 107 cases failed: the Linux client printed the BSD wording, had no `telnet>` prompt, no
 * option machinery and answered no suboption. Two recorder defects were found on the way and fixed in the oracle rather than in the
 * engine: a server `close` that never sent the FIN (the corpus showed an empty screen where the real client prints "Connection closed
 * by foreign host."), and a `start` step that hard-coded an empty server_got, hiding the initial option offer. The cases that also
 * pass for a client that merely echoes bytes are the plain data-translation and controls sessions (witnesses of the harness).
 */
import { describe, it, expect } from 'vitest';
import corpus from '../../support/oracle/telnet-client-netkit.json';
import { NetkitTelnetClient } from '@/network/protocols/telnet/client/NetkitTelnetClient';
import { PipeTerminal, PtyDiscipline, PtyHost, RECORDED_PATH, ScriptedPeer, fromHex, settle, toHex } from '../../support/telnet/NetkitPty';

interface CommandScenario { lines: string[]; env?: Record<string, string>; steps: Array<{ type: string | null; screen: string }> }
interface SessionStep { step: string | [string, string]; screen: string; server_got: string }
interface SessionScenario {
  argv: string[]; port: number | null; env?: Record<string, string> | null; rc?: string | null; steps: Array<[string, string | number | number[]]>; result: SessionStep[];
}
interface ArgScenario { argv: string[]; screen: string }

interface PipeStep { step: string | [string, string | number]; stdout: string; server_got: string; exit: number | null }
interface PipeScenario { argv: string[]; steps: Array<[string, string | number]>; result: PipeStep[] }

const pipes = (corpus as unknown as { pipes: Record<string, PipeScenario> }).pipes;
const commands = corpus.commands as unknown as Record<string, CommandScenario>;
const sessions = corpus.sessions as unknown as Record<string, SessionScenario>;
const args = corpus.args as unknown as Record<string, ArgScenario[]>;

function environmentOf(extra: Record<string, string> | undefined): Array<readonly [string, string]> {
  const base: Array<readonly [string, string]> = [['TERM', 'xterm'], ['PATH', RECORDED_PATH], ['HOME', '/root'], ['USER', 'root'], ['LOGNAME', 'root']];
  return [...base, ...Object.entries(extra ?? {})];
}

function launch(argv: string[], host: PtyHost): { client: NetkitTelnetClient; tty: PtyDiscipline; exits: number[] } {
  const tty = new PtyDiscipline();
  const client = new NetkitTelnetClient(host, tty, 'telnet', '/tmp/tl/telnet');
  tty.client = client;
  const exits: number[] = [];
  client.onExit((code) => {
    exits.push(code);
    tty.exited = true;
  });
  void client.start(argv);
  return { client, tty, exits };
}

describe('netkit-telnet 0.17 client — command mode against the real binary', () => {
  for (const [name, scenario] of Object.entries(commands)) {
    it(`${name}`, async () => {
      const host = new PtyHost({ environment: environmentOf(scenario.env) });
      const { tty } = launch([], host);
      await settle();
      const observed: Array<{ type: string | null; screen: string }> = [{ type: null, screen: tty.take() }];
      for (const line of scenario.lines) {
        tty.type(`${line}\r`);
        await settle();
        observed.push({ type: line, screen: tty.take() });
      }
      expect(observed).toEqual(scenario.steps);
    });
  }
});

describe('netkit-telnet 0.17 client — command line against the real binary', () => {
  for (const [name, list] of Object.entries(args)) {
    list.forEach((scenario, index) => {
      it(`${name} #${index} ${JSON.stringify(scenario.argv)}`, async () => {
        const host = new PtyHost();
        const { tty } = launch(scenario.argv, host);
        await settle();
        expect(tty.take()).toBe(scenario.screen);
      });
    });
  }
});

describe('netkit-telnet 0.17 client — sessions against the real binary', () => {
  for (const [name, scenario] of Object.entries(sessions)) {
    it(`${name}`, async () => {
      const peer = new ScriptedPeer();
      const port = scenario.port ?? 40000;
      const host = new PtyHost({
        peers: { [port]: peer },
        environment: environmentOf(scenario.env ?? undefined),
        files: scenario.rc ? { '/root/.telnetrc': scenario.rc } : undefined,
      });
      const argv = scenario.argv.map((a) => a.replace('<PORT>', String(port)));
      const { client, tty } = launch(argv, host);
      await settle();
      const clean = (text: string): string => text.replace(new RegExp(String(port), 'g'), '<PORT>');
      const observed: SessionStep[] = [{ step: 'start', screen: clean(tty.take()), server_got: toHex(peer.drain()) }];
      for (const [kind, payload] of scenario.steps) {
        if (kind === 'type') tty.type(fromHex(payload as string));
        else if (kind === 'send') peer.send(fromHex(payload as string));
        else if (kind === 'close') peer.close();
        else if (kind === 'resize') {
          const [rows, cols] = payload as number[];
          host.resize(rows, cols);
          client.signal('WINCH');
        }
        await settle();
        observed.push({ step: [kind, payload] as unknown as [string, string], screen: clean(tty.take()), server_got: toHex(peer.drain()) });
      }
      expect(observed).toEqual(scenario.result);
    });
  }
});

describe('netkit-telnet 0.17 client — standard input is a pipe, not a terminal', () => {
  for (const [name, scenario] of Object.entries(pipes)) {
    it(`${name}`, async () => {
      const peer = new ScriptedPeer();
      const port = 40000;
      const host = new PtyHost({ peers: { [port]: peer }, tty: false });
      const terminal = new PipeTerminal();
      const client = new NetkitTelnetClient(host, terminal, 'telnet', '/tmp/tl/telnet');
      const exits: number[] = [];
      client.onExit((code) => exits.push(code));
      void client.start(scenario.argv.map((a) => a.replace('<PORT>', String(port))));
      await settle();
      const clean = (text: string): string => text.replace(new RegExp(String(port), 'g'), '<PORT>');
      const exitCode = (): number | null => (exits.length > 0 ? exits[0] : null);
      const observed: PipeStep[] = [{ step: 'start', stdout: clean(terminal.take()), server_got: toHex(peer.drain()), exit: exitCode() }];
      for (const [kind, payload] of scenario.steps) {
        if (kind === 'stdin') client.input(fromHex(payload as string));
        else if (kind === 'eof') client.endOfInput();
        else if (kind === 'send') peer.send(fromHex(payload as string));
        else if (kind === 'close') peer.close();
        await settle();
        observed.push({ step: [kind, payload] as [string, string | number], stdout: clean(terminal.take()), server_got: toHex(peer.drain()), exit: exitCode() });
      }
      expect(observed).toEqual(scenario.result);
    });
  }
});
