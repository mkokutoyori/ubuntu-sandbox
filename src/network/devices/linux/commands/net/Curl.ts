import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import type { CurlHost } from '@/network/http/curl/CurlHost';
import { runCurl, CURL_FLAGS, CURL_USAGE } from '@/network/http/curl/CurlEngine';

function linuxCurlHost(ctx: LinuxCommandContext): CurlHost {
  return {
    async resolveHostname(name: string): Promise<string | null> {
      const ip = await ctx.net.resolveHostname(name);
      return ip ? ip.toString() : null;
    },
    tcpStack: () => ctx.net.getTcpStack(),
    trustAnchors: () => ctx.tlsTrustAnchors,
    readFile(path: string): string | null {
      const vfs = ctx.executor.vfs;
      return vfs.readFile(vfs.normalizePath(path, ctx.executor.getCwd()));
    },
    writeFile(target: string, content: string): boolean {
      const vfs = ctx.executor.vfs;
      return vfs.writeFile(
        vfs.normalizePath(target, ctx.executor.getCwd()),
        content,
        ctx.executor.userMgr.currentUid,
        ctx.executor.userMgr.currentGid,
        0o022,
      );
    },
  };
}

export const curlCommand: LinuxCommand = {
  name: 'curl',
  package: 'curl',
  needsNetworkContext: true,
  complete: makeArgCompleter({ flags: [...CURL_FLAGS] }),
  manSection: 1,
  usage: CURL_USAGE,
  help: 'Transfer data from or to a server.',
  options: [
    { flag: '-I', description: 'Fetch the headers only (sends a real HEAD request).', aliases: ['--head'] },
    { flag: '-i', description: 'Include the response headers in the output.', aliases: ['--include'] },
    { flag: '-k', description: 'Skip TLS certificate verification.', aliases: ['--insecure'] },
    { flag: '-s', description: 'Silent mode: no error messages.', aliases: ['--silent'] },
    { flag: '-S', description: 'Show errors even in silent mode.', aliases: ['--show-error'] },
    { flag: '-v', description: 'Write the protocol dialogue to stderr.', aliases: ['--verbose'] },
    { flag: '-f', description: 'Exit with 22 when the server answers 400 or above.', aliases: ['--fail'] },
    { flag: '-L', description: 'Follow redirects.', aliases: ['--location'] },
    { flag: '-o', description: 'Write the body to this file.', takesArg: true, argName: 'file', aliases: ['--output'] },
    { flag: '-O', description: 'Write the body to a file named after the remote path.', aliases: ['--remote-name'] },
    { flag: '-w', description: 'Print this format after the transfer (%{http_code}, ...).', takesArg: true, argName: 'format', aliases: ['--write-out'] },
    { flag: '-X', description: 'Request method to use.', takesArg: true, argName: 'method', aliases: ['--request'] },
    { flag: '-d', description: 'Send this data as the request body (implies POST).', takesArg: true, argName: 'data', aliases: ['--data'] },
    { flag: '-H', description: 'Add or replace a request header.', takesArg: true, argName: 'header', aliases: ['--header'] },
    { flag: '-u', description: 'HTTP Basic credentials.', takesArg: true, argName: 'user:password', aliases: ['--user'] },
    { flag: '-A', description: 'User-Agent to send.', takesArg: true, argName: 'agent', aliases: ['--user-agent'] },
    { flag: '--resolve', description: 'Resolve host:port to this address instead of using DNS.', takesArg: true, argName: 'host:port:addr' },
    { flag: '--max-redirs', description: 'Maximum number of redirects to follow.', takesArg: true, argName: 'num' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const result = await runCurl(linuxCurlHost(ctx), args);
    return [result.output, result.stderr].filter((s) => s.length > 0).join('\n');
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    const result = await runCurl(linuxCurlHost(ctx), args);
    return { output: result.output, exitCode: result.exitCode, stderr: result.stderr };
  },
};
