import type { Equipment } from '@/network/equipment/Equipment';
import { isOk } from '@/network/protocols/ssh/Result';
import { ROUTER_SSH_LOCAL_USER } from '@/network/protocols/ssh/localFs/sshLocalFsFor';
import type { SshDialect } from '@/terminal/ssh/sshDialect';
import {
  openWireSshConnection, relayScriptedShell, resolveSshTarget, silentConnectIo,
} from '@/terminal/ssh/wireSshLogin';

export interface RouterOutboundSshRequest {
  readonly device: Equipment;
  readonly dialect: SshDialect;
  readonly user: string;
  readonly host: string;
  readonly port: number;
  readonly command: string;
  readonly password?: string;
  readonly allocatePty?: boolean;
}

export async function runRouterOutboundSsh(req: RouterOutboundSshRequest): Promise<string> {
  const target = await resolveSshTarget(req.device, req.host, req.port, req.dialect);
  if (target.kind === 'failed') return target.line;
  const outcome = await openWireSshConnection({
    device: req.device,
    localUser: ROUTER_SSH_LOCAL_USER,
    user: req.user,
    host: target.address,
    port: req.port,
    io: silentConnectIo(),
    password: req.password,
    credentialless: req.password === undefined,
    strict: 'accept-new',
    quiet: true,
  });
  switch (outcome.kind) {
    case 'cancelled': return '';
    case 'host-key-changed': return 'Host key verification failed.';
    case 'auth-failed': return `${req.user}@${req.host}: Permission denied (${outcome.methods ?? 'publickey,password'}).`;
    case 'rejected':
    case 'unreachable': return outcome.message;
    case 'connected': break;
  }
  const { session } = outcome;
  try {
    const unquoted = req.command.replace(/^(['"])(.*)\1$/s, '$2');
    const command = /^(exit|logout)\s*$/i.test(unquoted) ? '' : unquoted;
    if (command !== '') {
      const channel = session.openExecChannel(command, req.allocatePty === true
        ? { environment: new Map(), pty: { term: 'vt100', columns: 80, rows: 24 } }
        : undefined);
      if (!isOk(channel)) return '';
      const result = await channel.value.execute();
      channel.value.close();
      return (result?.stdout ?? '').replace(/\n+$/, '');
    }
    const shell = session.openShellChannel();
    if (!isOk(shell)) return '';
    const relayed = await relayScriptedShell(shell.value, '', 0, true);
    shell.value.close();
    return [relayed.output, `Connection to ${req.host} closed.`].filter((part) => part.length > 0).join('\n');
  } finally {
    session.disconnect();
  }
}
