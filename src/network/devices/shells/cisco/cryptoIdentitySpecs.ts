import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { CryptoIdentityList } from '../../../ipsec/IPSecTypes';

export const CRYPTO_IDENTITY_MODE = 'config-crypto-identity';

export interface CryptoIdentityEngine {
  readonly identityLists: Map<string, CryptoIdentityList>;
  getOrCreateIdentityList(name: string): CryptoIdentityList;
  showCryptoIdentity(name?: string): string;
  getOrCreateCryptoMapEntry(mapName: string, seq: number): { identityName?: string };
  getOrCreateDynamicMapEntry(dynMapName: string, seq: number): { identityName?: string };
}

export interface CryptoIdentityHost {
  engine(): CryptoIdentityEngine;
  selectIdentity(name: string | null): void;
  selectedIdentity(): string | null;
  selectedCryptoMapEntry(): { map: string; seq: number; dynamic: boolean } | null;
}

const CONFIG = Object.freeze(['config']);
const SUBMODE = Object.freeze([CRYPTO_IDENTITY_MODE]);
const MAP_ENTRY = Object.freeze(['config-crypto-map']);

const word = (name: string, description: string): ArgumentSpec => ({ name, type: 'WORD', description });

export function cryptoIdentitySpecs(host: () => CryptoIdentityHost): CommandSpec[] {
  const engine = () => host().engine();
  const list = (): CryptoIdentityList | null => {
    const name = host().selectedIdentity();
    return name ? engine().identityLists.get(name) ?? null : null;
  };
  const entry = (): { identityName?: string } | null => {
    const selected = host().selectedCryptoMapEntry();
    if (!selected) return null;
    return selected.dynamic
      ? engine().getOrCreateDynamicMapEntry(selected.map, selected.seq)
      : engine().getOrCreateCryptoMapEntry(selected.map, selected.seq);
  };
  return [
    {
      id: 'crypto-identity',
      path: ['crypto', 'identity', word('name', 'Identity of the router')],
      description: 'Identity of the peers allowed to use a crypto map', undoDescription: 'Delete the identity',
      modes: CONFIG, minPrivilege: 15,
      enters: CRYPTO_IDENTITY_MODE,
      run: (_s, args) => { engine().getOrCreateIdentityList(args.name); host().selectIdentity(args.name); return ''; },
      undo: (_s, args) => { engine().identityLists.delete(args.name); return ''; },
    },
    {
      id: 'crypto-identity-description',
      path: ['description', { name: 'text', type: 'REST', literal: 'LINE', description: 'Description' }],
      description: 'Description of the identity', undoDescription: 'Remove the description',
      modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const l = list(); if (l) l.description = args.text; return ''; },
      undo: () => { const l = list(); if (l) l.description = undefined; return ''; },
    },
    {
      id: 'crypto-identity-fqdn',
      path: ['fqdn', word('fqdn', 'Host name the peer authenticates with')],
      description: 'Host name of the peer', undoDescription: 'Remove the host name',
      modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const l = list(); if (l) l.fqdn = args.fqdn; return ''; },
      undo: () => { const l = list(); if (l) l.fqdn = undefined; return ''; },
    },
    {
      id: 'crypto-identity-dn',
      path: ['dn', { name: 'dn', type: 'REST', literal: 'LINE', description: 'Distinguished name component, FIELD=VALUE' }],
      description: 'Distinguished name component of the peer certificate', undoDescription: 'Remove a component',
      modes: SUBMODE, minPrivilege: 15,
      run: (_s, args) => {
        if (!/^[A-Za-z]+\s*=\s*\S/.test(args.dn)) return '% A distinguished name component is written FIELD=VALUE';
        const l = list(); if (l && !l.dn.includes(args.dn)) l.dn.push(args.dn);
        return '';
      },
      undo: (_s, args) => { const l = list(); if (l) l.dn = args.dn ? l.dn.filter((x) => x !== args.dn) : []; return ''; },
    },
    {
      id: 'crypto-map-set-identity',
      path: ['set', 'identity', word('identity', 'Identity allowed to use the crypto map')],
      description: 'Restrict the crypto map entry to the peers of an identity', undoDescription: 'Remove the restriction',
      modes: MAP_ENTRY, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const e = entry(); if (e) e.identityName = args.identity; return ''; },
      undo: () => { const e = entry(); if (e) e.identityName = undefined; return ''; },
    },
    {
      id: 'show-crypto-identity',
      path: ['show', 'crypto', 'identity', { ...word('tag', 'Identity tag'), optional: true }],
      description: 'Display the crypto identity list',
      modes: ['privileged'], minPrivilege: 15,
      run: (_s, args) => engine().showCryptoIdentity(args.tag),
    },
  ];
}
