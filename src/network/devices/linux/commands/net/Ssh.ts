import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { proxyJumpRequest, wireExecTarget } from '../../network/LinuxSshClient';
import { runThroughProxyJump } from '../../network/SshProxyJump';
import { dialStream, parseDialAddress } from '@/network/tcp/dial';
import { PortNumber } from '@/network/core/ports/PortNumber';
import type { TcpConnector } from '@/network/tcp/types';

const SSH_USAGE = 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]\n'
  + '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]\n'
  + '           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]\n'
  + '           [-i identity_file] [-J destination] [-L address] [-l login_name]\n'
  + '           [-m mac_spec] [-O ctl_cmd] [-o option] [-p port] [-Q query_option]\n'
  + '           [-R address] [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n'
  + '           destination [command [argument ...]]';

export const sshCommand: LinuxCommand = {
  name: 'ssh',
  needsNetworkContext: true,
  manSection: 1,
  usage: SSH_USAGE,
  help: 'OpenSSH remote login client.',
  complete: makeArgCompleter({
    flags: ['-p', '-i', '-o', '-l', '-t', '-T', '-q', '-v', '-N', '-L', '-R', '-D', '-J', '-A'],
  }),
  options: [
    { flag: '-p', description: 'Port to connect to on the remote host.', takesArg: true, argName: 'port' },
    { flag: '-i', description: 'Identity (private key) file.', takesArg: true, argName: 'file' },
    { flag: '-o', description: 'Set an option in the ssh_config format.', takesArg: true, argName: 'option' },
    { flag: '-l', description: 'Login name on the remote machine.', takesArg: true, argName: 'login_name' },
    { flag: '-t', description: 'Force pseudo-terminal allocation.' },
    { flag: '-T', description: 'Disable pseudo-terminal allocation.' },
    { flag: '-q', description: 'Quiet mode.' },
    { flag: '-N', description: 'Do not execute a remote command.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    return (await runSsh(ctx, args, stdin)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return runSsh(ctx, args, stdin);
  },
};

function hostDialer(ctx: LinuxCommandContext): TcpConnector {
  return async (host, port) => {
    const literal = parseDialAddress(host) ? host : (await ctx.net.resolveHostname(host))?.toString() ?? null;
    const destination = literal === null ? null : parseDialAddress(literal);
    if (!destination || !PortNumber.isValid(port)) return { dialFailed: 'unreachable' };
    return dialStream(ctx.net.getTcpStack(), destination, PortNumber.of(port));
  };
}

export async function runSsh(
  ctx: LinuxCommandContext, args: string[], stdin?: string, offeredPassword?: string,
): Promise<{ output: string; exitCode: number }> {
  const jump = proxyJumpRequest(args);
  if (!jump) return ctx.executor.runSshExecAsync(args, offeredPassword);
  const typedLines = (ctx.executor._scenarioStdin ?? '').split('\n');
  const nextPassword = offeredPassword !== undefined
    ? () => offeredPassword
    : () => typedLines.shift() ?? '';
  const client = ctx.executor.wireSshClient();
  const expanded = jump.remaining.map((word) =>
    word === '~' ? client.home : word.startsWith('~/') ? client.home + word.slice(1) : word);
  const parsed = wireExecTarget(expanded, ctx.executor.vfs, ctx.executor.getCwd(), client.user);
  if (!parsed) return { output: SSH_USAGE, exitCode: 255 };
  const target = parsed;
  return runThroughProxyJump({
    client,
    dial: hostDialer(ctx),
    hops: jump.hops,
    nextPassword,
    target,
    command: target.command,
    stdin: stdin ?? '',
  });
}
