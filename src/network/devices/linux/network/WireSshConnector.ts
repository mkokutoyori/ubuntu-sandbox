import { SshSession } from '../../../protocols/ssh/session/SshSession';
import { SilentSshInteractionHandler, type ISshInteractionHandler } from '../../../protocols/ssh/session/ISshInteractionHandler';
import { TerminalSshInteractionHandler, type ITerminalIO } from '../../../protocols/ssh/session/TerminalSshInteractionHandler';
import {
  OPENSSH_CLIENT_AUTHENTICATION,
  OPENSSH_DEFAULT_IDENTITY_FILES,
  SshConnectOptionsBuilder,
  type SshClientAuthentication,
} from '../../../protocols/ssh/SshConnectOptions';
import type { SshAlgorithmPreferences } from '../../../protocols/ssh/transport/SshTransport';
import { isOk, type SshError } from '../../../protocols/ssh/Result';
import type { ISshLocalFs } from '../../../protocols/ssh/ISshLocalFs';
import type { TcpConnector } from '@/network/tcp/types';
import type { AgentPort } from '../../../protocols/ssh/agent/AgentService';

export type { StrictHostKeyChecking } from '../../../protocols/ssh/SshConnectOptions';
import type { StrictHostKeyChecking } from '../../../protocols/ssh/SshConnectOptions';

export interface WireSshClient {
  readonly vfs: ISshLocalFs;
  readonly user: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly agent?: AgentPort;
}

export interface WireSshTarget {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly password?: string;
  readonly passwordPrompt?: () => string;
  readonly io?: ITerminalIO;
  readonly identities: readonly string[];
  readonly certificateFiles?: readonly string[];
  readonly strict: StrictHostKeyChecking;
  readonly authentication?: SshClientAuthentication;
  readonly algorithms?: SshAlgorithmPreferences;
  readonly knownHosts?: { readonly user: readonly string[]; readonly global: readonly string[] };
  readonly hashKnownHosts?: boolean;
  readonly identitiesOnly?: boolean;
}

export interface WireSshOutcome {
  readonly session: SshSession | null;
  readonly failure: SshError | null;
  readonly notices: readonly string[];
  readonly warnings: readonly string[];
  readonly refusedSession?: SshSession;
  readonly streamed: boolean;
}

export async function connectWireSsh(
  client: WireSshClient, target: WireSshTarget, connector: TcpConnector,
): Promise<WireSshOutcome> {
  const silent = new SilentSshInteractionHandler(
    target.passwordPrompt ?? target.password ?? '', target.strict !== 'ask');
  const interaction: ISshInteractionHandler = target.io === undefined ? silent : new TerminalSshInteractionHandler(target.io);
  const session = new SshSession({
    tcpConnector: connector,
    vfs: client.vfs,
    localUser: client.user,
    localUid: client.uid,
    localGid: client.gid,
    knownHostsPath: `${client.home}/.ssh/known_hosts`,
    credentialless: target.io === undefined && target.password === undefined && target.passwordPrompt === undefined,
    interactionHandler: interaction,
    ...(client.agent === undefined || target.identitiesOnly === true ? {} : { agent: client.agent }),
  });
  const builder = SshConnectOptionsBuilder.create()
    .host(target.host).user(target.user).port(target.port).strictHostKeyChecking(target.strict)
    .authentication(target.authentication ?? OPENSSH_CLIENT_AUTHENTICATION);
  if (target.algorithms) builder.algorithms(target.algorithms);
  if (target.knownHosts) builder.knownHosts(target.knownHosts);
  if (target.hashKnownHosts !== undefined) builder.hashKnownHosts(target.hashKnownHosts);
  for (const path of target.identities) builder.addIdentityFile(path);
  for (const path of target.certificateFiles ?? []) builder.addCertificateFile(path);
  if (target.identities.length === 0 && target.identitiesOnly !== true) {
    for (const candidate of OPENSSH_DEFAULT_IDENTITY_FILES) {
      const path = `${client.home}/.ssh/${candidate}`;
      if (client.vfs.readFile(path) !== null) builder.addIdentityFile(path);
    }
  }
  const result = await session.connect(builder.build());
  if (!isOk(result)) {
    session.disconnect();
    return { session: null, failure: result.error, notices: silent.notices, warnings: silent.warnings, refusedSession: session, streamed: target.io !== undefined };
  }
  return { session, failure: null, notices: silent.notices, warnings: silent.warnings, streamed: target.io !== undefined };
}
