/**
 * wireSshLogin — opening an SSH session over the real wire, for any
 * terminal that can type `ssh`.
 *
 * There is one SSH client in the simulator, not one per vendor. What a
 * Linux, Windows or router terminal supplies is only what genuinely
 * differs: which device it runs on, which local account it runs as, and
 * where that vendor keeps its client files. Everything after that — the
 * reachability question, the TCP connection, the authentication
 * exchange, the shell channel — happens here and is identical whoever
 * asked (docs/PRD-SSH-Unification.md §4bis B4).
 *
 * The connection this opens is the only one the login makes: the
 * pre-flight reachability question is answered from the cabled topology
 * rather than dialled, so the server never sees a handshake for a
 * connection no client kept.
 */

import type { Equipment } from '@/network/equipment/Equipment';
import type { TcpConnector } from '@/network/tcp/types';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { TerminalSshInteractionHandler } from '@/network/protocols/ssh/session/TerminalSshInteractionHandler';
import { QueuedTerminalIO, QueuedTerminalIOCancelled } from '@/network/protocols/ssh/session/QueuedTerminalIO';
import { isOk } from '@/network/protocols/ssh/Result';
import { peerLiveness } from '@/network/protocols/ssh/sessionLiveness';
import { sshLocalFsFor, knownHostsPathFor } from '@/network/protocols/ssh/localFs/sshLocalFsFor';
import { IPAddress } from '@/network/core/types';

export interface WireSshLoginRequest {
  /** The device typing `ssh`. */
  readonly device: Equipment;
  /** Local account the client runs as — picks the known_hosts store. */
  readonly localUser: string;
  readonly localUid?: number;
  readonly localGid?: number;
  /** Remote account being logged into. */
  readonly user: string;
  readonly host: string;
  readonly port: number;
  /**
   * Reactive IO the auth exchange prompts through, for terminals that
   * let the SSH layer raise its own challenge.
   */
  readonly io: QueuedTerminalIO;
  /**
   * Password already collected by the caller's own challenge. Supplied
   * instead of letting the SSH layer prompt — the exchange on the wire
   * is the same either way, only the keyboard route differs.
   */
  readonly password?: string;
  readonly strict?: 'yes' | 'no' | 'accept-new';
  readonly identityFiles?: readonly string[];
}

export type WireSshLoginOutcome =
  | { kind: 'connected'; session: SshSession; channel: ReturnType<SshSession['openShellChannel']> extends { value: infer C } ? C : never }
  | { kind: 'unreachable'; message: string }
  | { kind: 'rejected'; message: string }
  /** The host presented a key that differs from the stored one. */
  | { kind: 'host-key-changed' }
  /** Authentication failed — already reported to the user by the SSH layer. */
  | { kind: 'auth-failed' }
  | { kind: 'cancelled' };

/**
 * The password is already in hand at this point, so the connection needs
 * no keyboard: anything the SSH layer would ask goes nowhere. Shared by
 * every caller that has already collected the password through its own
 * vendor-specific prompt (Linux/Windows/Cisco/Huawei outbound `ssh`) and
 * just needs `SshSession.connect()` to authenticate silently with it.
 */
export function silentConnectIo(): QueuedTerminalIO {
  return new QueuedTerminalIO({
    writeLine: () => undefined,
    beginPrompt: () => undefined,
    endPrompt: () => undefined,
  });
}

/** The TCP dialler this device exposes, whatever shape it comes in. */
function tcpConnectorFor(device: Equipment): TcpConnector | null {
  const dev = device as unknown as {
    tcpConnect?: (host: string, port: number) => Promise<unknown>;
    getTcpStack?: () => { connect: (host: string, port: number) => unknown };
  };
  if (typeof dev.tcpConnect === 'function') {
    return ((host, port) => dev.tcpConnect!(host, port)) as TcpConnector;
  }
  const stack = dev.getTcpStack?.();
  if (stack) {
    return ((host, port) => Promise.resolve(stack.connect(host, port))) as TcpConnector;
  }
  return null;
}

/**
 * Connect and open an interactive shell channel. Returns what happened
 * rather than printing it — the caller owns its own terminal's wording.
 */
export async function openWireSshShell(
  req: WireSshLoginRequest,
): Promise<WireSshLoginOutcome> {
  const tcpConnector = tcpConnectorFor(req.device);
  if (!tcpConnector) {
    return { kind: 'unreachable', message: `ssh: connect to host ${req.host} port ${req.port}: Network is unreachable` };
  }

  // Is there a path at all. Read off the topology — the connection made
  // just below is what actually settles it, and probing first would cost
  // a second connection for nothing.
  if (IPAddress.tryParse(req.host) && !peerLiveness(req.device, req.host)()) {
    return { kind: 'unreachable', message: `ssh: connect to host ${req.host} port ${req.port}: No route to host` };
  }

  const session = new SshSession({
    tcpConnector,
    vfs: sshLocalFsFor(req.device) as never,
    localUser: req.localUser,
    localUid: req.localUid ?? 1000,
    localGid: req.localGid ?? 1000,
    knownHostsPath: knownHostsPathFor(req.device, req.localUser),
    interactionHandler: new TerminalSshInteractionHandler(req.io),
  });

  const builder = SshConnectOptionsBuilder.create()
    .host(req.host)
    .user(req.user)
    .port(req.port)
    .strictHostKeyChecking(req.strict ?? 'accept-new');
  if (req.password !== undefined) builder.password(req.password);
  for (const id of req.identityFiles ?? []) builder.addIdentityFile(id);

  let result: Awaited<ReturnType<typeof session.connect>> | null = null;
  try {
    result = await session.connect(builder.build());
  } catch (err) {
    if (!(err instanceof QueuedTerminalIOCancelled)) throw err;
    session.disconnect();
    return { kind: 'cancelled' };
  }

  if (!result || !isOk(result)) {
    const errKind = result ? (result as { error: { kind: string } }).error.kind : 'UNKNOWN';
    session.disconnect();
    if (errKind === 'AUTH_FAILED') return { kind: 'auth-failed' };
    if (errKind === 'CONNECTION_REFUSED') {
      return { kind: 'unreachable', message: `ssh: connect to host ${req.host} port ${req.port}: No route to host` };
    }
    if (errKind === 'HOST_KEY_CHANGED') return { kind: 'host-key-changed' };
    if (errKind === 'HOST_KEY_REJECTED') {
      return { kind: 'rejected', message: 'Host key verification failed.' };
    }
    return { kind: 'rejected', message: `${req.user}@${req.host}: Permission denied (publickey,password).` };
  }

  const channelResult = session.openShellChannel();
  if (!isOk(channelResult)) {
    session.disconnect();
    return { kind: 'rejected', message: 'ssh: failed to open shell channel' };
  }

  return { kind: 'connected', session, channel: channelResult.value as never };
}
