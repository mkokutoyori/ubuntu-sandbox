import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import { installDefaultShells, reinstallDefaultShells } from '@/shell/registerDefaults';
import { ShellFactory } from '@/shell/ShellFactory';
import { AbstractShell } from '@/shell/AbstractShell';
import type { ShellLineResult } from '@/shell/IShell';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');
type Reply = { stdout: string; stderr: string; exitCode: number; prompt?: string };

async function oracleShell(): Promise<ISshShellChannel> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.14.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.14.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: { readFile: () => null, writeFile: () => undefined, resolveInode: () => null, mkdirp: () => undefined } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host('10.0.14.2').user('alice').password('alice').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed: ' + JSON.stringify((connected as { error: unknown }).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return channel.value;
}

describe('Oracle sub-shells stack on the server side of the wire (docs/PRD-SSH-Unification.md §4bis B2)', () => {
  it('bash answers before any sub-shell is entered', async () => {
    const ch = await oracleShell();
    const res = await ch.runLine('whoami') as Reply;
    expect(res.stdout).toContain('alice');
    expect(res.prompt).toMatch(/^alice@/);
  }, 30000);

  it('sqlplus switches the prompt to SQL>', async () => {
    const ch = await oracleShell();
    const res = await ch.runLine('sqlplus / as sysdba') as Reply;
    expect(res.prompt).toMatch(/^SQL>/);
  }, 30000);

  it('a SQL statement runs once inside SQL*Plus', async () => {
    const ch = await oracleShell();
    await ch.runLine('sqlplus / as sysdba');
    const res = await ch.runLine('select 1 from dual;') as Reply;
    expect(res.stdout).toContain('1');
    expect(res.stdout).not.toContain('command not found');
  }, 30000);

  it('exit pops back to bash rather than ending the session', async () => {
    const ch = await oracleShell();
    await ch.runLine('sqlplus / as sysdba');
    await ch.runLine('exit');
    const res = await ch.runLine('whoami') as Reply;
    expect(res.stdout).toContain('alice');
    expect(res.prompt).toMatch(/^alice@/);
  }, 30000);

  it('rman switches the prompt to RMAN>', async () => {
    const ch = await oracleShell();
    const res = await ch.runLine('rman target /') as Reply;
    expect(res.prompt).toMatch(/^RMAN>/);
  }, 30000);

  it('completion follows the shell that is on top of the stack', async () => {
    const ch = await oracleShell();
    await ch.runLine('sqlplus / as sysdba');
    const candidates = await ch.complete('sel');
    expect(candidates.some((c) => /^select/i.test(c))).toBe(true);
  }, 30000);
});

describe('a newly registered interpreter reaches the wire with no further wiring', () => {
  afterEach(() => { reinstallDefaultShells(); });

  /**
   * The contract a future python3 / psql / mysql adapter relies on:
   * declaring a `launcher` alongside the constructor is the whole
   * integration — nothing in the terminal, the SSH server or the wire
   * needs to learn the new command.
   */
  class FakeReplShell extends AbstractShell {
    readonly kind = 'fake-repl';
    getPrompt(): string { return 'fake=# '; }
    override getCompletions(line: string): readonly string[] {
      return line.startsWith('SEL') ? ['SELECT'] : [];
    }
    protected async dispatch(line: string): Promise<ShellLineResult> {
      if (line.trim() === '\\q') return { output: [], exit: true };
      return { output: [`fake ran: ${line}`] };
    }
  }

  beforeEach(() => {
    ShellFactory.register(
      'fake-repl',
      (a) => new FakeReplShell(a),
      { launcher: /^fakedb\b/i, launchableFrom: ['bash'] },
    );
  });

  it('opens its REPL, answers, completes and quits over SSH', async () => {
    const ch = await oracleShell();

    const entered = await ch.runLine('fakedb --connect') as Reply;
    expect(entered.prompt).toBe('fake=# ');

    const ran = await ch.runLine('SELECT 1') as Reply;
    expect(ran.stdout).toContain('fake ran: SELECT 1');

    expect(await ch.complete('SEL')).toContain('SELECT');

    await ch.runLine('\\q');
    const back = await ch.runLine('whoami') as Reply;
    expect(back.stdout).toContain('alice');
    expect(back.prompt).toMatch(/^alice@/);
  }, 30000);
});
