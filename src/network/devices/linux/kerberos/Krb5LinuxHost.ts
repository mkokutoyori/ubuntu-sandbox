import { RRType } from '@/network/dns/wire/RRType';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import type { LinuxCommandContext } from '../commands/LinuxCommandContext';
import { readResolverIP } from '../commands/dns/resolverIP';
import { forwardHostOfAsync, reverseNameOfAsync } from '../network/ReverseName';
import type { Krb5Host, SrvRecord } from './Krb5Host';

function bytesOfLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

function latin1Of(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

const SRV_TIMEOUT_MS = 2000;
const CREDENTIAL_CACHE_UMASK = 0o077;

export function linuxKrb5Host(ctx: LinuxCommandContext): Krb5Host {
  const vfs = ctx.executor.vfs;
  const users = ctx.executor.userMgr;
  return {
    environment: (name) => ctx.executor.commandEnvironment()[name] ?? null,
    readText: (path) => vfs.readFile(path),
    readBytes(path) {
      const text = vfs.readFile(path);
      return text === null ? null : bytesOfLatin1(text);
    },
    writeBytes: (path, bytes) => vfs.writeFile(path, latin1Of(bytes), users.currentUid, users.currentGid, CREDENTIAL_CACHE_UMASK),
    removeFile: (path) => vfs.deleteFile(path),
    fileExists: (path) => vfs.exists(path),
    listDirectory: (path) => vfs.listDirectory(path)?.map((entry) => entry.name) ?? null,
    uid: () => users.currentUid,
    userName: () => users.currentUser,
    nowMicroseconds: () => ctx.executor.simulatedDate().getTime() * 1000,
    async resolve(name) {
      const address = await ctx.net.resolveHostname(name);
      return address === null ? null : address.toString();
    },
    forward: (name) => forwardHostOfAsync(ctx.executor.nss, name),
    reverse: (address) => reverseNameOfAsync(ctx.executor.nss, address),
    async querySrv(name): Promise<readonly SrvRecord[]> {
      const resolver = readResolverIP(ctx.executor);
      if (resolver === '') return [];
      const reply = await ctx.net.queryDns(resolver, name, 'SRV', SRV_TIMEOUT_MS);
      if (reply === null) return [];
      const records: SrvRecord[] = [];
      for (const answer of reply.answers) {
        const data = answer.data;
        if (data.type === RRType.SRV) {
          records.push({ target: data.target, port: data.port, priority: data.priority, weight: data.weight });
        }
      }
      return records;
    },
    dialKdc(address, port) {
      if (port !== 88) return null;
      const dialed = dialKdc(ctx.net.getTcpStack(), address);
      return dialed.ok && dialed.client !== undefined ? dialed.client : null;
    },
  };
}
