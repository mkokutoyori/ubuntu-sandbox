import { SshSession } from '../../../protocols/ssh/session/SshSession';
import { SilentSshInteractionHandler } from '../../../protocols/ssh/session/ISshInteractionHandler';
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

export type StrictHostKeyChecking = 'yes' | 'no' | 'accept-new';

export interface WireSshClient {
  readonly vfs: ISshLocalFs;
  readonly user: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

export interface WireSshTarget {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly password?: string;
  readonly passwordPrompt?: () => string;
  readonly identities: readonly string[];
  readonly strict: StrictHostKeyChecking;
  readonly authentication?: SshClientAuthentication;
  readonly algorithms?: SshAlgorithmPreferences;
}

export interface WireSshOutcome {
  readonly session: SshSession | null;
  readonly failure: SshError | null;
  readonly notices: readonly string[];
  readonly warnings: readonly string[];
}

export async function connectWireSsh(
  client: WireSshClient, target: WireSshTarget, connector: TcpConnector,
): Promise<WireSshOutcome> {
  const interaction = new SilentSshInteractionHandler(
    target.passwordPrompt ?? target.password ?? '', target.strict !== 'yes');
  const session = new SshSession({
    tcpConnector: connector,
    vfs: client.vfs,
    localUser: client.user,
    localUid: client.uid,
    localGid: client.gid,
    knownHostsPath: `${client.home}/.ssh/known_hosts`,
    credentialless: target.password === undefined && target.passwordPrompt === undefined,
    interactionHandler: interaction,
  });
  const builder = SshConnectOptionsBuilder.create()
    .host(target.host).user(target.user).port(target.port).strictHostKeyChecking(target.strict)
    .authentication(target.authentication ?? OPENSSH_CLIENT_AUTHENTICATION);
  if (target.algorithms) builder.algorithms(target.algorithms);
  for (const path of target.identities) builder.addIdentityFile(path);
  if (target.identities.length === 0) {
    for (const candidate of OPENSSH_DEFAULT_IDENTITY_FILES) {
      const path = `${client.home}/.ssh/${candidate}`;
      if (client.vfs.readFile(path) !== null) builder.addIdentityFile(path);
    }
  }
  const result = await session.connect(builder.build());
  if (!isOk(result)) {
    session.disconnect();
    return { session: null, failure: result.error, notices: interaction.notices, warnings: interaction.warnings };
  }
  return { session, failure: null, notices: interaction.notices, warnings: interaction.warnings };
}
