import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { runLdapsearch, type LdapToolHost } from '@/network/ldap/openldap/ldapsearch';
import type { LdapChannel, LdapTransport, TlsUpgradeRequest, TlsUpgradeOutcome, ChannelRead, ConnectOutcome } from '@/network/ldap/openldap/ldapChannel';
import { kernelHostname } from '../../KernelHostname';
import { formatCtime } from '../../time/ctime';
import { dialLdap, type LdapClient } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { pemToCertChain } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { TlsRequireCert } from '@/network/ldap/openldap/ldapOptions';
import type { TlsClientConfig } from '@/network/tls/TlsClientSession';

const SASL_CLIENT_MECHANISMS = [
  'ANONYMOUS', 'CRAM-MD5', 'DIGEST-MD5', 'LOGIN', 'NTLM', 'OTP', 'PLAIN', 'SCRAM-SHA-1', 'SCRAM-SHA-256',
] as const;

class ClientChannel implements LdapChannel {
  constructor(
    private readonly client: LdapClient,
    private readonly upgrade: (client: LdapClient, request: TlsUpgradeRequest) => TlsUpgradeOutcome,
  ) {
    client.openRawLink();
  }

  get peerAddress(): string {
    return this.client.peerAddress;
  }

  get localEndpoint(): string {
    return this.client.localEndpoint;
  }

  write(bytes: Uint8Array): boolean {
    return this.client.rawWrite(bytes);
  }

  read(want: number): ChannelRead {
    return this.client.rawRead(want);
  }

  readable(): boolean {
    return this.client.rawReadable();
  }

  upgradeTls(request: TlsUpgradeRequest): TlsUpgradeOutcome {
    return this.upgrade(this.client, request);
  }

  close(): void {
    this.client.closeRawLink();
  }
}

function trustAnchorsFor(ctx: LinuxCommandContext, request: TlsUpgradeRequest): readonly X509Certificate[] {
  const bundle = request.tls.caCertFile;
  if (bundle === null) return ctx.tlsTrustAnchors;
  const vfs = ctx.executor.vfs;
  const pem = vfs.readFile(vfs.normalizePath(bundle, ctx.executor.getCwd()));
  return pem === null ? [] : pemToCertChain(pem);
}

function upgradeLdapTls(
  ctx: LinuxCommandContext, client: LdapClient, request: TlsUpgradeRequest,
): TlsUpgradeOutcome {
  const mode = request.tls.requireCert;
  const lenient = mode === TlsRequireCert.NEVER || mode === TlsRequireCert.ALLOW;
  const config: TlsClientConfig = {
    verifier: new CertificateVerifier({ trustAnchors: trustAnchorsFor(ctx, request) }),
    allowUntrustedPeer: lenient,
    serverName: request.serverName,
  };
  const outcome = client.attachTls(config);
  if (outcome.ok) return { ok: true };
  return { ok: false, detail: '(unknown error code)' };
}

const ENETUNREACH = 101;
const ETIMEDOUT = 110;
const ECONNREFUSED = 111;

function linuxLdapTransport(ctx: LinuxCommandContext): LdapTransport {
  return {
    async resolve(name: string): Promise<readonly string[] | null> {
      const address = await ctx.net.resolveHostname(name);
      return address ? [address.toString()] : null;
    },
    connect(address: string, port: number): ConnectOutcome {
      const dialed = dialLdap(ctx.net.getTcpStack(), address, port);
      if (!dialed.ok || dialed.client === undefined) {
        return { kind: 'failed', errno: dialed.reason === 'refused' ? ECONNREFUSED : dialed.reason === 'unroutable' ? ENETUNREACH : ETIMEDOUT };
      }
      return { kind: 'connected', channel: new ClientChannel(dialed.client, (client, request) => upgradeLdapTls(ctx, client, request)) };
    },
  };
}

function bytesOfText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function linuxLdapToolHost(ctx: LinuxCommandContext, stdin: string | undefined): LdapToolHost {
  const vfs = ctx.executor.vfs;
  const resolve = (path: string): string => vfs.normalizePath(path, ctx.executor.getCwd());
  let stdinPosition = 0;
  const input = stdin ?? '';
  const users = ctx.executor.userMgr;
  return {
    environment: (name) => ctx.executor.commandEnvironment()[name] ?? null,
    readTextFile: (path) => vfs.readFile(resolve(path)),
    readFile(path) {
      const inode = vfs.resolveInode(resolve(path));
      if (inode === null) return { error: 'No such file or directory' };
      if (inode.type === 'directory') return { error: 'Is a directory' };
      if (!vfs.checkAccess(inode, 'r', users.currentUid, users.currentGid)) return { error: 'Permission denied' };
      return { bytes: bytesOfText(vfs.readFile(resolve(path)) ?? '') };
    },
    fileMode(path) {
      const inode = vfs.resolveInode(resolve(path));
      return inode === null ? null : inode.permissions & 0o7777;
    },
    createTemporaryFile(template, bytes) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let suffix = '';
      for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
      const path = template.replace(/XXXXXX$/, suffix);
      const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
      const created = vfs.createFileAt(resolve(path), binary, 0o600, users.currentUid, users.currentGid);
      return created === null ? { error: 'No such file or directory' } : { path };
    },
    transport: linuxLdapTransport(ctx),
    clock: {
      now: () => Math.floor(ctx.executor.simulatedDate().getTime() / 1000),
      nowMicroseconds: () => ctx.executor.simulatedDate().getTime() * 1000,
      ctime: (seconds: number) => `${formatCtime(new Date(seconds * 1000))}\n`,
    },
    readStdinLine() {
      if (stdinPosition >= input.length) return null;
      const newline = input.indexOf('\n', stdinPosition);
      const line = input.slice(stdinPosition, newline < 0 ? undefined : newline);
      stdinPosition = newline < 0 ? input.length : newline + 1;
      return line;
    },
    readStdinCharacter() {
      return stdinPosition < input.length ? input[stdinPosition++] : null;
    },
    localHostName: () => kernelHostname(vfs),
    localAddress: () => null,
    saslClientMechanisms: () => SASL_CLIENT_MECHANISMS,
    lookupDomainHosts: () => null,
  };
}

async function execute(ctx: LinuxCommandContext, args: string[], stdin: string | undefined) {
  const result = await runLdapsearch(['ldapsearch', ...args], linuxLdapToolHost(ctx, stdin));
  return {
    output: result.stdout.replace(/\n$/, ''),
    exitCode: result.exitCode,
    stderr: result.stderr.replace(/\n$/, ''),
    interleaved: result.interleaved.replace(/\n$/, ''),
  };
}

export const ldapsearchCommand: LinuxCommand = {
  name: 'ldapsearch',
  package: 'ldap-utils',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: 'ldapsearch [options] [filter [attributes...]]',
  help: 'ldapsearch - LDAP search tool',
  complete: makeArgCompleter({
    flags: ['-x', '-H', '-b', '-s', '-D', '-w', '-W', '-y', '-Z', '-ZZ', '-L', '-LL', '-LLL', '-z', '-l', '-a', '-A', '-c', '-E', '-e', '-f', '-F', '-M', '-P', '-S', '-t', '-T', '-u', '-v', '-V', '-n', '-N', '-o', '-d', '-I', '-Q', '-O', '-R', '-U', '-X', '-Y'],
    wordsAfter: { '-s': ['base', 'one', 'sub', 'children'], '-a': ['never', 'always', 'search', 'find'] },
  }),
  options: [
    { flag: '-x', description: 'Simple authentication' },
    { flag: '-H', description: 'LDAP Uniform Resource Identifier(s)', takesArg: true, argName: 'URI' },
    { flag: '-b', description: 'base dn for search', takesArg: true, argName: 'basedn' },
    { flag: '-s', description: 'one of base, one, sub or children (search scope)', takesArg: true, argName: 'scope' },
    { flag: '-D', description: 'bind DN', takesArg: true, argName: 'binddn' },
    { flag: '-w', description: 'bind password (for simple authentication)', takesArg: true, argName: 'passwd' },
    { flag: '-W', description: 'prompt for bind password' },
    { flag: '-y', description: 'Read password from file', takesArg: true, argName: 'file' },
    { flag: '-Z', description: 'Start TLS request (-ZZ to require successful response)' },
    { flag: '-L', description: 'print responses in LDIFv1 format (-LL without comments, -LLL also without version)' },
    { flag: '-z', description: 'size limit (in entries, or "none" or "max") for search', takesArg: true, argName: 'limit' },
    { flag: '-l', description: 'time limit (in seconds, or "none" or "max") for search', takesArg: true, argName: 'limit' },
    { flag: '-a', description: 'one of never (default), always, search, or find', takesArg: true, argName: 'deref' },
    { flag: '-A', description: 'retrieve attribute names only (no values)' },
    { flag: '-c', description: 'continuous operation mode (do not stop on errors)' },
    { flag: '-E', description: 'search extensions (! indicates criticality)', takesArg: true, argName: '[!]<ext>[=<extparam>]' },
    { flag: '-e', description: 'general extensions (! indicates criticality)', takesArg: true, argName: '[!]<ext>[=<extparam>]' },
    { flag: '-f', description: "read operations from `file'", takesArg: true, argName: 'file' },
    { flag: '-S', description: 'sort the results by attribute', takesArg: true, argName: 'attr' },
    { flag: '-u', description: 'include User Friendly entry names in the output' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    const result = await execute(ctx, args, stdin);
    return result.interleaved;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return execute(ctx, args, stdin);
  },
};
