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
  service(e: NssServiceEntry): string {
    const aliases = e.aliases.length ? `  ${e.aliases.join(' ')}` : '';
    return `${e.name.padEnd(15)} ${e.port}/${e.protocol}${aliases}`;
  },
  protocol(e: NssProtocolEntry): string {
    const aliases = e.aliases.length ? `  ${e.aliases.join(' ')}` : '';
    return `${e.name.padEnd(15)} ${e.number}${aliases}`;
  },
  network(e: NssNetworkEntry): string {
    const aliases = e.aliases.length ? `  ${e.aliases.join(' ')}` : '';
    return `${e.name.padEnd(15)} ${e.network}${aliases}`;
  },
  ethers(e: NssEthersEntry): string {
    return `${e.mac} ${e.hostname}`;
  },
  rpc(e: NssRpcEntry): string {
    const aliases = e.aliases.length ? `  ${e.aliases.join(' ')}` : '';
    return `${e.name.padEnd(15)} ${e.number}${aliases}`;
  },
  netgroup(e: NssNetgroupEntry): string {
    const tris = e.triples
      .map(t => `(${t.host},${t.user},${t.domain})`)
      .join(' ');
    return `${e.name} ${tris}`.trim();
  },
};
