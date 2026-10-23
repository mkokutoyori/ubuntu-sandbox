import { forwardHostOfAsync, reverseNameOfAsync } from '../../network/ReverseName';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { runLdapsearch, type LdapToolHost } from '@/network/ldap/openldap/ldapsearch';
import type { LdapChannel, LdapTlsState, LdapTransport, TlsUpgradeRequest, TlsUpgradeOutcome, ChannelRead, ConnectOutcome } from '@/network/ldap/openldap/ldapChannel';
import { kernelHostname } from '../../KernelHostname';
import { formatCtime } from '../../time/ctime';
import { dialLdap, type LdapClient } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { connectTls, type TlsConnectHost } from '@/network/ldap/openldap/tls/tlsConnect';
import { ldapDistinguishedName } from '@/network/pki/der/DistinguishedName';
import type { TlsFiles } from '@/network/ldap/openldap/tls/tlsContext';
import { SASL_PLUGIN_DIRECTORY, loadClientPlugins } from '@/network/ldap/openldap/sasl/saslPlugins';
import { Krb5Context } from '../../kerberos/Krb5Context';
import { Krb5GssClient } from '../../kerberos/Krb5GssClient';
import { linuxKrb5Host } from '../../kerberos/Krb5LinuxHost';


class ClientChannel implements LdapChannel {
  constructor(
    private readonly client: LdapClient,
    private readonly upgrade: (client: LdapClient, request: TlsUpgradeRequest) => Promise<TlsUpgradeOutcome>,
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

  upgradeTls(request: TlsUpgradeRequest): Promise<TlsUpgradeOutcome> {
    return this.upgrade(this.client, request);
  }

  tlsState(): LdapTlsState | null {
    const channel = this.client.tlsChannel;
    return channel === null
      ? null
      : {
        strength: channel.keyBits,
        clientDn: channel.clientCertificate === null ? null : ldapDistinguishedName(channel.clientCertificate.subject),
        serverEndPoint: channel.serverEndPoint, unique: channel.unique,
      };
  }

  close(): void {
    this.client.closeRawLink();
  }
}

function readableFile(ctx: LinuxCommandContext, path: string): { bytes: Uint8Array } | { error: string } {
  const vfs = ctx.executor.vfs;
  const users = ctx.executor.userMgr;
  const resolved = vfs.normalizePath(path, ctx.executor.getCwd());
  const inode = vfs.resolveInode(resolved);
  if (inode === null) return { error: 'No such file or directory' };
  if (inode.type === 'directory') return { error: 'Is a directory' };
  if (!vfs.checkAccess(inode, 'r', users.currentUid, users.currentGid)) return { error: 'Permission denied' };
  return { bytes: bytesOfText(vfs.readFile(resolved) ?? '') };
}

function tlsFilesOf(ctx: LinuxCommandContext): TlsFiles {
  const vfs = ctx.executor.vfs;
  return {
    read: (path) => readableFile(ctx, path),
    regularFiles(directory) {
      const resolved = vfs.normalizePath(directory, ctx.executor.getCwd());
      const entries = vfs.listDirectory(resolved);
      if (entries === null) return null;
      return entries
        .filter((entry) => vfs.resolveInode(`${resolved}/${entry.name}`)?.type === 'file')
        .map((entry) => entry.name);
    },
  };
}

function tlsConnectHostOf(ctx: LinuxCommandContext, client: LdapClient): TlsConnectHost {
  return {
    files: tlsFilesOf(ctx),
    async localFqdn() {
      const hostname = kernelHostname(ctx.executor.vfs);
      return (await forwardHostOfAsync(ctx.executor.nss, hostname))?.canonicalName ?? hostname;
    },
    handshake(config) {
      const { ok, session } = client.attachTls(config);
      const verification = session.peerVerified
        ? { ok: true as const }
        : { ok: false as const, reason: session.peerVerificationReason ?? 'unknown' };
      return {
        established: ok, alert: session.lastAlert !== null,
        localAlert: session.peerAlert === null ? session.lastAlert?.description ?? null : null, certificate: session.peerCertificate,
        chain: session.peerCertificateChain, verification,
      };
    },
    detach: () => client.detachTls(),
  };
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
    reverse: (address: string) => reverseNameOfAsync(ctx.executor.nss, address),
    connect(address: string, port: number): ConnectOutcome {
      const dialed = dialLdap(ctx.net.getTcpStack(), address, port);
      if (!dialed.ok || dialed.client === undefined) {
        return { kind: 'failed', errno: dialed.reason === 'refused' ? ECONNREFUSED : dialed.reason === 'unroutable' ? ENETUNREACH : ETIMEDOUT };
      }
      return { kind: 'connected', channel: new ClientChannel(dialed.client, (client, request) => connectTls(request, tlsConnectHostOf(ctx, client))) };
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
    readFile: (path) => readableFile(ctx, path),
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
    sasl: {
      plugins: () => loadClientPlugins(vfs.listDirectory(SASL_PLUGIN_DIRECTORY)?.map((entry) => entry.name) ?? null),
      hostname: () => kernelHostname(vfs),
      random: (length) => crypto.getRandomValues(new Uint8Array(length)),
      gss() {
        const host = linuxKrb5Host(ctx);
        return new Krb5GssClient(host, new Krb5Context(host));
      },
    },
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
  foregroundClient: true,
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
