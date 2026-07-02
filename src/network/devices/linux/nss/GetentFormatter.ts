/**
 * GetentFormatter — render NSS entries in canonical `getent` line format.
 *
 * Real getent's line format is the same as the `/etc/<db>` file format:
 *   passwd  → name:passwd:uid:gid:gecos:dir:shell
 *   group   → name:passwd:gid:m1,m2,...
 *   shadow  → name:passwd:lstchg:min:max:warn:inact:expire:flag
 *   gshadow → name:passwd:admins:members
 *   hosts   → "address  canonicalName aliases..."   (16-col padding)
 *   services→ "name      port/proto  aliases..."    (4-col tabs)
 *   protocols/networks/rpc → "name  number  aliases..."
 *   ethers  → "mac hostname"
 *
 * Centralised here so the command handler stays a thin orchestrator.
 */

import type {
  NssEthersEntry, NssGroupEntry, NssGshadowEntry, NssHostEntry,
  NssNetgroupEntry, NssNetworkEntry, NssPasswdEntry, NssProtocolEntry,
  NssRpcEntry, NssServiceEntry, NssShadowEntry,
} from './types';

const aliasSuffix = (aliases: string[]): string => aliases.map(a => ` ${a}`).join('');

export const GetentFormatter = {
  passwd(e: NssPasswdEntry): string {
    return `${e.name}:${e.passwd}:${e.uid}:${e.gid}:${e.gecos}:${e.dir}:${e.shell}`;
  },
  group(e: NssGroupEntry): string {
    return `${e.name}:${e.passwd}:${e.gid}:${e.members.join(',')}`;
  },
  shadow(e: NssShadowEntry): string {
    const s = (v: number | '') => v === '' ? '' : String(v);
    return `${e.name}:${e.passwd}:${s(e.lstchg)}:${s(e.min)}:${s(e.max)}:${s(e.warn)}:${s(e.inact)}:${s(e.expire)}:${s(e.flag)}`;
  },
  gshadow(e: NssGshadowEntry): string {
    return `${e.name}:${e.passwd}:${e.admins.join(',')}:${e.members.join(',')}`;
  },
  host(e: NssHostEntry): string {
    const names = [e.canonicalName, ...e.aliases].join(' ');
    return `${e.address.padEnd(16)}${names}`;
  },
  ahosts(e: NssHostEntry): string[] {
    const addr = e.address.padEnd(15);
    return [
      `${addr} STREAM ${e.canonicalName}`,
      `${addr} DGRAM`,
      `${addr} RAW`,
    ];
  },
  service(e: NssServiceEntry): string {
    return `${e.name.padEnd(21)} ${e.port}/${e.protocol}${aliasSuffix(e.aliases)}`;
  },
  protocol(e: NssProtocolEntry): string {
    return `${e.name.padEnd(21)} ${e.number}${aliasSuffix(e.aliases)}`;
  },
  network(e: NssNetworkEntry): string {
    return `${e.name.padEnd(21)} ${e.network}${aliasSuffix(e.aliases)}`;
  },
  ethers(e: NssEthersEntry): string {
    return `${e.mac} ${e.hostname}`;
  },
  rpc(e: NssRpcEntry): string {
    return `${e.name.padEnd(15)} ${e.number}${aliasSuffix(e.aliases)}`;
  },
  netgroup(e: NssNetgroupEntry): string {
    const tris = e.triples
      .map(t => `(${t.host},${t.user},${t.domain})`)
      .join(' ');
    return `${e.name} ${tris}`.trim();
  },
};
