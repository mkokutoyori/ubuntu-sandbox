import { parseDN } from './ldap/LdapDN';
import type { DirectoryDelta, DirectorySnapshot } from './DirectoryStore';

export interface ForestPromotion {
  kind?: 'forest';
  promotedAt?: number;
  invocationId?: string;
  domainName: string;
  netbiosName: string;
  safeModeAdminPassword: string;
  forestMode: string;
  domainMode: string;
  installDns?: boolean;
  databasePath?: string;
  logPath?: string;
  sysvolPath?: string;
}

export interface ChildDomainPromotion {
  kind: 'childDomain';
  promotedAt?: number;
  invocationId?: string;
  domainName: string;
  netbiosName: string;
  parentDomainName: string;
  safeModeAdminPassword: string;
  installDns?: boolean;
}

export interface ReplicaPromotion {
  kind: 'replica';
  promotedAt?: number;
  invocationId?: string;
  domainName: string;
  netbiosName: string;
  sourceDcAddress: string;
  safeModeAdminPassword: string;
  installDns?: boolean;
}

export type DirectoryPromotion = ForestPromotion | ChildDomainPromotion | ReplicaPromotion;

export function promotionKind(promotion: DirectoryPromotion): 'forest' | 'childDomain' | 'replica' {
  return promotion.kind ?? 'forest';
}

export function snapshotAsDelta(snapshot: DirectorySnapshot): DirectoryDelta {
  return {
    ...snapshot,
    nextRid: 0,
    localUsn: 0,
    guidCounter: 0,
    removedDns: [],
    removedAcls: [],
    schema: { attributes: [], classes: [] },
    highWatermark: [],
  };
}

const VOLATILE_ATTRIBUTES = new Set([
  'objectguid', 'whencreated', 'whenchanged', 'usncreated', 'usnchanged', 'pwdlastset',
  'lastlogon', 'lastlogontimestamp', 'badpasswordtime', 'logoncount',
]);

const sameKey = (dn: string): string => dn.toLowerCase();

const PROVISIONED_SECRET_OWNERS = ['cn=krbtgt,'];

function isProvisionedSecret(dn: string, attribute: string): boolean {
  return attribute === 'userpassword' && PROVISIONED_SECRET_OWNERS.some((owner) => sameKey(dn).startsWith(owner));
}

function signature(dn: string, attributes: Record<string, string[]>): string {
  return JSON.stringify(Object.entries(attributes)
    .filter(([name]) => !VOLATILE_ATTRIBUTES.has(name) && !isProvisionedSecret(dn, name))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, values]) => [name, [...values].sort()]));
}

function isSchemaEntry(dn: string): boolean {
  const lower = sameKey(dn);
  return lower.startsWith('cn=schema,cn=configuration,') || lower.includes(',cn=schema,cn=configuration,');
}

export function diffDirectory(live: DirectorySnapshot, factory: DirectorySnapshot, ownsSchema = true): DirectoryDelta | null {
  const factoryEntries = new Map(factory.entries.map((e) => [sameKey(e.dn), signature(e.dn, e.attributes)]));
  const liveKeys = new Set(live.entries.map((e) => sameKey(e.dn)));
  const entries = live.entries.filter((e) =>
    !isSchemaEntry(e.dn) && factoryEntries.get(sameKey(e.dn)) !== signature(e.dn, e.attributes));
  const removedDns = factory.entries
    .filter((e) => !isSchemaEntry(e.dn) && !liveKeys.has(sameKey(e.dn)))
    .map((e) => e.dn)
    .sort((a, b) => parseDN(b).length - parseDN(a).length);

  const factoryAcls = new Map(factory.acls.map((a) => [a.dn, JSON.stringify(a.rules)]));
  const acls = live.acls.filter((a) => factoryAcls.get(a.dn) !== JSON.stringify(a.rules));
  const liveAcls = new Set(live.acls.map((a) => a.dn));
  const removedAcls = factory.acls.map((a) => a.dn).filter((dn) => !liveAcls.has(dn));

  const factoryAttributes = new Set(factory.schema.attributes.map((a) => JSON.stringify(a)));
  const factoryClasses = new Set(factory.schema.classes.map((c) => JSON.stringify(c)));
  const schema = ownsSchema
    ? {
      attributes: live.schema.attributes.filter((a) => !factoryAttributes.has(JSON.stringify(a))),
      classes: live.schema.classes.filter((c) => !factoryClasses.has(JSON.stringify(c))),
    }
    : { attributes: [], classes: [] };

  const factoryScopes = new Map(factory.optionalFeatureScopes.map((s) => [s.name, JSON.stringify(s.scopes)]));
  const optionalFeatureScopes = live.optionalFeatureScopes.filter((s) => factoryScopes.get(s.name) !== JSON.stringify(s.scopes));
  const kdsRootKey = live.kdsRootKey && JSON.stringify(live.kdsRootKey) !== JSON.stringify(factory.kdsRootKey) ? live.kdsRootKey : null;

  const factoryWatermark = new Map(factory.highWatermark);
  const highWatermark = live.highWatermark.filter(([id, usn]) => factoryWatermark.get(id) !== usn);

  const unchanged = highWatermark.length + entries.length + removedDns.length + acls.length + removedAcls.length
    + schema.attributes.length + schema.classes.length + optionalFeatureScopes.length === 0 && kdsRootKey === null;
  return unchanged
    ? null
    : { entries, removedDns, acls, removedAcls, kdsRootKey, nextRid: live.nextRid, localUsn: live.localUsn, guidCounter: live.guidCounter, optionalFeatureScopes, schema, highWatermark };
}
