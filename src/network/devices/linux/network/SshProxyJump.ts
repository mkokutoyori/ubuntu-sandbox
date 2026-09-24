import type { SshSession } from '../../../protocols/ssh/session/SshSession';
import { isOk, type SshError } from '../../../protocols/ssh/Result';
import type { TcpConnector, TcpDialFailure } from '@/network/tcp/types';
import type { ProxyHop } from '@/terminal/sessions/sshArgs';
import { relayScriptedShell } from '@/terminal/ssh/wireSshLogin';
import { connectWireSsh, type WireSshClient, type WireSshTarget } from './WireSshConnector';

export interface ProxyJumpRun {
  readonly client: WireSshClient;
  readonly dial: TcpConnector;
  readonly hops: readonly ProxyHop[];
  readonly nextPassword?: () => string;
  readonly target: WireSshTarget;
  readonly command: string;
  readonly stdin: string;
}

export interface ProxyJumpResult {
  readonly output: string;
  readonly exitCode: number;
}

const SSH_FAILURE = 255;
const DEFAULT_SSH_PORT = 22;
const PROXY_CLOSED = 'Connection closed by UNKNOWN port 65535';

const CONNECT_ERRORS: Readonly<Record<string, string>> = {
  CONNECTION_REFUSED: 'Connection refused',
  CONNECTION_TIMEOUT: 'Connection timed out',
  CONNECTION_UNREACHABLE: 'Network is unreachable',
};

function describeFailure(
  endpoint: { host: string; port: number }, failure: SshError | null, warnings: readonly string[],
): string {
  const connectError = failure ? CONNECT_ERRORS[failure.kind] : undefined;
  if (connectError) return `ssh: connect to host ${endpoint.host} port ${endpoint.port}: ${connectError}`;
  if (warnings.length > 0) return warnings.join('\n');
  return `ssh: connect to host ${endpoint.host} port ${endpoint.port}: ${failure?.kind ?? 'failed'}`;
}

function tunnelThrough(session: SshSession, refusals: string[]): TcpConnector {
  return async (host, port) => {
    const opened = await session.openDirectTcpip(host, port);
    if (isOk(opened)) return opened.value;
    const reason = opened.error.kind === 'CHANNEL_ERROR' ? opened.error.message : opened.error.kind;
    refusals.push(`channel 0: open failed: ${reason}`);
    const refused: TcpDialFailure = { dialFailed: 'refused' };
    return refused;
  };
}

async function runOnSession(session: SshSession, command: string, stdin: string): Promise<ProxyJumpResult> {
  if (command) {
    const channel = session.openExecChannel(command);
    if (!isOk(channel)) return { output: '', exitCode: SSH_FAILURE };
    const result = await channel.value.execute();
    channel.value.close();
    return { output: result.stdout, exitCode: result.exitCode };
  }
  const shell = session.openShellChannel();
  if (!isOk(shell)) return { output: '', exitCode: SSH_FAILURE };
  const relayed = await relayScriptedShell(shell.value, stdin, 0, true);
  shell.value.close();
  return relayed;
}

export async function runThroughProxyJump(run: ProxyJumpRun): Promise<ProxyJumpResult> {
  const sessions: SshSession[] = [];
  const refusals: string[] = [];
  let connector = run.dial;
  try {
    for (const hop of run.hops) {
      const endpoint = { host: hop.host, port: hop.port ?? DEFAULT_SSH_PORT };
      const reached = await connectWireSsh(run.client, {
        host: endpoint.host, user: hop.user ?? run.client.user, port: endpoint.port,
        passwordPrompt: run.nextPassword, identities: [], strict: run.target.strict,
      }, connector);
      if (!reached.session) {
        const cause = refusals.length > 0
          ? [...refusals, 'stdio forwarding failed']
          : [describeFailure(endpoint, reached.failure, reached.warnings)];
        return { output: [...cause, PROXY_CLOSED].join('\n'), exitCode: SSH_FAILURE };
      }
      sessions.push(reached.session);
      connector = tunnelThrough(reached.session, refusals);
    }
    const final = await connectWireSsh(
      run.client, { ...run.target, passwordPrompt: run.nextPassword }, connector);
    if (!final.session) {
      const cause = refusals.length > 0
        ? [...refusals, 'stdio forwarding failed', PROXY_CLOSED]
        : [describeFailure(run.target, final.failure, final.warnings)];
      return { output: cause.join('\n'), exitCode: SSH_FAILURE };
    }
    sessions.push(final.session);
    return await runOnSession(final.session, run.command, run.stdin);
  } finally {
    for (const session of sessions.reverse()) session.disconnect();
  }
}
