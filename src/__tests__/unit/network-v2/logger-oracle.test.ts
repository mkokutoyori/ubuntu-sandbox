/*
 * Oracle: logger 2.39.3 (util-linux, Ubuntu 24.04 binary).  scripts/oracle/record_logger.py runs the real tool against
 * listeners it opens itself - an AF_UNIX datagram or stream socket, a loopback UDP or TCP port, or no socket at all - with
 * time, hostname, pid and uid pinned by scripts/oracle/last_shim.c, and stores what each listener received together with
 * stdout, stderr and the exit status.  The same argv, stdin and file are replayed through runLogger and compared on the
 * bytes sent, stdout, stderr and status.  Measured before the port (module absent, git stash push -u -- src/network):
 * every invocation falls.  Invocations that only print usage, the version or an option error pass whatever the transport
 * is; they are kept because option handling is part of the tool.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runLogger, type LoggerHost, type LoggerOpen } from '@/network/devices/linux/syslog/LoggerTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';

interface Run {
  kind: 'unix-dgram' | 'unix-stream' | 'inet-udp' | 'inet-tcp' | 'none';
  argv: string[];
  stdin: string;
  file: string;
  stdout: string;
  stderr: string;
  code: number;
  packets: string[];
  stream: string;
}
interface Scenario {
  env: { TZ: string; now: number; usec: number; hostname: string; pid: number; uid: number; users: Record<string, number> };
  runs: Run[];
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/logger-2.39.3.json', 'utf8')) as { scenarios: Scenario[] };
const UDP = 2;
const TCP = 4;

function hostFor(scenario: Scenario, run: Run, sink: { packets: Uint8Array[]; stream: number[] }): LoggerHost {
  const stdin = Uint8Array.from(Buffer.from(run.stdin, 'base64'));
  const file = Uint8Array.from(Buffer.from(run.file, 'base64'));
  const open = (type: number): LoggerOpen => ({
    type,
    connection: {
      send: (bytes) => {
        if (type === UDP) sink.packets.push(Uint8Array.from(bytes));
        else sink.stream.push(...bytes);
        return null;
      },
      close: () => undefined,
    },
  });
  const login = Object.entries(scenario.env.users).find(([, uid]) => uid === scenario.env.uid)?.[0] ?? null;
  return {
    nowMicros: () => scenario.env.now * 1_000_000 + scenario.env.usec,
    clock: hostClock(scenario.env.TZ),
    hostname: () => (scenario.env.hostname.length > 255 ? null : scenario.env.hostname),
    pid: () => scenario.env.pid,
    login: () => login,
    isRoot: () => scenario.env.uid === 0,
    processExists: () => false,
    sdBooted: () => false,
    connectUnix: (path, types) => {
      if (run.kind === 'unix-dgram' && path === '@W/log.sock') return types & UDP ? open(UDP) : { error: 'Protocol wrong type for socket' };
      if (run.kind === 'unix-stream' && path === '@W/log.sock') return types & TCP ? open(TCP) : { error: 'Protocol wrong type for socket' };
      return { error: 'No such file or directory' };
    },
    connectInet: (server, port, types) => {
      if (run.kind === 'inet-udp' && types & UDP) return open(UDP);
      if (run.kind === 'inet-tcp' && types & TCP && !(types & UDP)) return open(TCP);
      if (run.kind === 'inet-tcp' && types & UDP) return open(UDP);
      return { fatal: `failed to connect to ${server} port ${port ?? 'syslog-conn'}` };
    },
    readFile: (path) => (path === '@W/input.txt' ? { bytes: file } : { error: 'No such file or directory' }),
    stdin: () => stdin,
    journal: () => true,
  };
}

describe('logger 2.39.3 oracle', () => {
  it('sends the same bytes and prints the same text for every recorded invocation', () => {
    const failures: string[] = [];
    let total = 0;
    fixture.scenarios.forEach((scenario, index) => {
      for (const run of scenario.runs) {
        total++;
        const sink = { packets: [] as Uint8Array[], stream: [] as number[] };
        const result = runLogger(hostFor(scenario, run, sink), run.argv);
        const packets = sink.packets.map((packet) => Buffer.from(packet).toString('base64'));
        const stream = Buffer.from(sink.stream).toString('base64');
        const asText = (recorded: string): string => Buffer.from(recorded, 'latin1').toString('utf8');
        if (result.stdout !== asText(run.stdout) || result.stderr !== asText(run.stderr) || result.exitCode !== run.code
          || JSON.stringify(packets) !== JSON.stringify(run.packets) || stream !== run.stream) {
          failures.push(`#${index} ${run.kind} ${JSON.stringify(run.argv)}\n got ${JSON.stringify([result.stdout, result.stderr, result.exitCode, packets.map((p) => Buffer.from(p, 'base64').toString('latin1')), Buffer.from(stream, 'base64').toString('latin1')])}\nwant ${JSON.stringify([run.stdout, run.stderr, run.code, run.packets.map((p) => Buffer.from(p, 'base64').toString('latin1')), Buffer.from(run.stream, 'base64').toString('latin1')])}`);
        }
      }
    });
    expect(failures.length, failures.slice(0, 4).join('\n')).toBe(0);
    expect(total).toBeGreaterThan(700);
  });
});
