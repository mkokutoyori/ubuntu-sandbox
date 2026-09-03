/**
 * DirectoryTree — a real LDAP Directory Information Tree (DIT): entries
 * keyed by DN, each holding a real multi-valued attribute map, organized
 * as a parent/child tree matching the DN hierarchy. This is the engine
 * `LdapServer` operates on for real Add/Search/Modify/Delete/Compare —
 * not a flat lookup table with cosmetic DN strings.
 */

import {
  type DistinguishedName, type Rdn, parseDN, formatDN, dnEquals, parentOf, isDescendantOf,
} from './LdapDN';
import { type LdapFilter, type AttributeSource, evaluateFilter } from './LdapFilter';
import type { HighWatermarkVector } from '../replication/HighWatermarkVector';
import type { SchemaValidator } from '../schema/SchemaValidator';

/**
 * Multi-DC replication stamp (PRD-Windows-Server-Advanced.md §5 P4,
 * inspired by MS-DRSR's per-object USN, simplified to entry granularity
 * rather than real AD's per-attribute versioning — this simulator's scope
 * excludes attribute-level conflict resolution/tombstones/USN rollback).
 */
export interface EntryReplMeta {
  readonly originatingInvocationId: string;
  readonly originatingUsn: number;
  readonly timestamp: number; // epoch seconds — comme l'« originating time » d'AD
  /**
   * Le nombre de fois que cette entrée a été écrite, en comptant les
   * écritures venues d'un partenaire : c'est la VERSION d'AD, et c'est
   * le premier critère de résolution de conflit.
   *
   * Elle manquait, et la comparaison se faisait sur l'heure seule — or
   * l'heure d'origine d'AD est en SECONDES (ici comme là-bas). Deux
   * écritures séparées de moins d'une seconde étaient donc départagées
   * au hasard du découpage des secondes, ce qui a produit un défaut
   * intermittent bien réel : pendant `Install-ADDSDomainController`, le
   * contrôleur promu crée une racine locale vide puis tire celle de son
   * partenaire ; quand les deux créations tombaient dans deux secondes
   * différentes, la racine locale — plus « récente » — l'emportait et
   * les attributs FSMO n'arrivaient jamais. Le laboratoire échouait
   * environ une fois sur vingt, selon l'endroit où tombait la seconde.
   *
   * Optionnelle pour que des données antérieures restent lisibles : une
   * entrée sans version compte pour 0.
   */
  readonly version?: number;
}

/** Supplied by a replicating `DirectoryStore` so every local write is auto-stamped; absent (`undefined`) for any `DirectoryTree` that doesn't participate in replication (e.g. the LDAP wire-protocol unit tests), which never touch `replMeta`. */
/**
 * La résolution de conflit d'Active Directory, dans son ordre réel :
 * **version**, puis **heure d'origine**, puis **DSA d'origine**.
 *
 * Rend vrai quand la copie LOCALE l'emporte sur celle qui arrive — donc
 * quand il faut refuser l'entrée entrante.
 *
 * L'ordre compte, et il n'était pas respecté : seule l'heure était
 * comparée, alors que l'heure d'origine d'AD a une résolution d'UNE
 * SECONDE. Deux écritures rapprochées se départageaient donc selon le
 * découpage des secondes, c'est-à-dire au hasard. La version est le
 * critère principal chez Microsoft précisément pour cela ; le DSA
 * d'origine ne sert qu'à trancher une égalité parfaite, arbitrairement
 * mais de façon STABLE — ce qui est le point, une égalité doit se
 * résoudre pareil sur les deux contrôleurs, sinon ils divergent.
 */
function localWins(local: EntryReplMeta, entrant: EntryReplMeta): boolean {
  const vLocal = local.version ?? 0;
  const vEntrant = entrant.version ?? 0;
  if (vLocal !== vEntrant) return vLocal > vEntrant;
  if (local.timestamp !== entrant.timestamp) return local.timestamp > entrant.timestamp;
  return local.originatingInvocationId > entrant.originatingInvocationId;
}

export interface ReplicationIdentity {
  readonly invocationId: string;
  nextUsn(): number;
}

export interface DirectoryEntry {
  readonly dn: DistinguishedName;
  /** lowercase attribute name → values (case preserved in the values themselves). */
  readonly attributes: Map<string, string[]>;
  readonly children: Map<string, DirectoryEntry>;
  /** Null on a non-replicating tree, or before this entry has ever been written on a replicating one (never true after `addEntry`, since that always stamps). */
  replMeta: EntryReplMeta | null;
}

export type SearchScope = 'base' | 'one' | 'sub';

export interface TreeOpResult { ok: boolean; message: string; }

export type ModOperation = 'add' | 'delete' | 'replace';
export interface Modification { op: ModOperation; type: string; values: string[]; }

function attrKey(name: string): string { return name.toLowerCase(); }

const MEMBER_ATTRIBUTE = 'member';
const MEMBER_OF_ATTRIBUTE = 'memberof';

function linkIndexKey(groupDn: string, memberDn: string): string {
  return `${groupDn.toLowerCase()}\u0000${memberDn.toLowerCase()}`;
}

/** Canonical key for one RDN: AVAs sorted+lowercased, so `CN=Bob+OU=X` and `OU=X+CN=Bob` key identically (RFC 4514 §2.3 multi-valued RDNs are order-independent). */
function rdnCanonicalKey(rdn: Rdn): string {
  return [...rdn].map(a => `${a.type.toLowerCase()}=${a.value.toLowerCase()}`).sort().join('+');
}

/** Canonical key for a DN's leaf RDN — used as the child-map key under a parent entry. */
function rdnKey(dn: DistinguishedName): string {
  const leaf = dn[0];
  return leaf ? rdnCanonicalKey(leaf) : '';
}

export function entryAttributeSource(entry: DirectoryEntry): AttributeSource {
  return { get: (attr: string) => entry.attributes.get(attrKey(attr)) };
}

export class DirectoryTree {
  private readonly root: DirectoryEntry;
  private readonly byDn = new Map<string, DirectoryEntry>();

  private readonly linkDeadlines = new Map<string, number>();
  private readonly canonicalAttributeNames = new Map<string, string>();

  private rememberAttributeNames(names: Iterable<string>): void {
    for (const name of names) {
      const key = attrKey(name);
      if (!this.canonicalAttributeNames.has(key)) this.canonicalAttributeNames.set(key, name);
    }
  }

  canonicalAttributeName(name: string): string {
    return this.canonicalAttributeNames.get(attrKey(name)) ?? name;
  }

  constructor(
    baseDn: string | DistinguishedName,
    rootAttributes: Record<string, string[]> = {},
    private readonly replication?: ReplicationIdentity,
    /** RFC 4512 schema validation (PRD-Windows-Server-Advanced.md §5 P7) — absent on any `DirectoryTree` with no schema partition (e.g. the LDAP wire-protocol unit tests), which behaves exactly as before this phase. */
    private readonly schema?: SchemaValidator,
    private readonly now: () => Date = () => new Date(),
  ) {
    const dn = typeof baseDn === 'string' ? parseDN(baseDn) : baseDn;
    this.root = { dn, attributes: toAttrMap(rootAttributes), children: new Map(), replMeta: this.stampFor() };
    this.byDn.set(this.dnIndexKey(dn), this.root);
  }

  private stampFor(precedent?: EntryReplMeta | null): EntryReplMeta | null {
    if (!this.replication) return null;
    return {
      originatingInvocationId: this.replication.invocationId,
      originatingUsn: this.replication.nextUsn(),
      timestamp: Math.floor(Date.now() / 1000),
      version: (precedent?.version ?? 0) + 1,
    };
  }

  /** Canonical index key: each RDN's AVAs sorted+lowercased, so order-independent multi-valued RDNs (RFC 4514 §2.3) index identically — matches `dnEquals`. */
  private dnIndexKey(dn: DistinguishedName): string { return dn.map(rdnCanonicalKey).join(','); }

  getRootDn(): DistinguishedName { return this.root.dn; }

  getByDn(dn: DistinguishedName): DirectoryEntry | null {
    return this.byDn.get(this.dnIndexKey(dn)) ?? null;
  }

  /** RFC 4511 §4.6 AddRequest — fails with entryAlreadyExists / noSuchObject (missing parent) / objectClassViolation (RFC 4512 schema, §5 P7 — only for `objectClass` values that have a registered `classSchema`; permissive for everything else). */
  addEntry(dn: DistinguishedName, attributes: Record<string, string[]>): TreeOpResult {
    if (dn.length === 0) return { ok: false, message: 'namingViolation: cannot add the root entry' };
    if (this.getByDn(dn)) return { ok: false, message: 'entryAlreadyExists' };
    const parentDn = parentOf(dn);
    if (parentDn === null) return { ok: false, message: 'noSuchObject: no parent' };
    const parent = this.getByDn(parentDn);
    if (!parent) return { ok: false, message: 'noSuchObject: parent does not exist' };
    if (this.schema) {
      const objectClasses = attributes.objectClass ?? attributes.objectclass ?? [];
      const validation = this.schema.validateNewEntry(objectClasses, attributes);
      if (!validation.ok) return validation;
    }
    this.rememberAttributeNames(Object.keys(attributes));
    const entry: DirectoryEntry = { dn, attributes: toAttrMap(attributes), children: new Map(), replMeta: this.stampFor() };
    parent.children.set(rdnKey(dn), entry);
    this.byDn.set(this.dnIndexKey(dn), entry);
    return { ok: true, message: '' };
  }

  setLinkTtl(groupDn: DistinguishedName, memberDn: string, ttlSeconds: number): void {
    this.linkDeadlines.set(linkIndexKey(formatDN(groupDn), memberDn), this.now().getTime() + ttlSeconds * 1000);
  }

  linkTtls(groupDn: DistinguishedName): Map<string, number> {
    this.expireLinks();
    const prefix = `${formatDN(groupDn).toLowerCase()}\u0000`;
    const nowMs = this.now().getTime();
    const out = new Map<string, number>();
    for (const [key, deadline] of this.linkDeadlines) {
      if (!key.startsWith(prefix)) continue;
      out.set(key.slice(prefix.length), Math.max(0, Math.round((deadline - nowMs) / 1000)));
    }
    return out;
  }

  expireLinks(): void {
    if (this.linkDeadlines.size === 0) return;
    const nowMs = this.now().getTime();
    for (const [key, deadline] of [...this.linkDeadlines]) {
      if (deadline > nowMs) continue;
      this.linkDeadlines.delete(key);
      const [groupDn, memberDn] = key.split('\u0000');
      let dn: DistinguishedName;
      try { dn = parseDN(groupDn); } catch { continue; }
      if (!this.getByDn(dn)) continue;
      this.modifyEntry(dn, [{ op: 'delete', type: MEMBER_ATTRIBUTE, values: [memberDn] }]);
    }
  }

  /** RFC 4511 §4.8 DelRequest — real AD (and this tree) refuses to delete a non-leaf entry. */
  deleteEntry(dn: DistinguishedName): TreeOpResult {
    const entry = this.getByDn(dn);
    if (!entry) return { ok: false, message: 'noSuchObject' };
    if (entry.children.size > 0) return { ok: false, message: 'notAllowedOnNonLeaf' };
    const parentDn = parentOf(dn);
    const parent = parentDn ? this.getByDn(parentDn) : null;
    parent?.children.delete(rdnKey(dn));
    this.byDn.delete(this.dnIndexKey(dn));
    return { ok: true, message: '' };
  }

  /** RFC 4511 §4.6 ModifyRequest — add/delete/replace on one or more attribute types. */
  modifyEntry(dn: DistinguishedName, changes: readonly Modification[]): TreeOpResult {
    const entry = this.getByDn(dn);
    if (!entry) return { ok: false, message: 'noSuchObject' };
    this.rememberAttributeNames(changes.map(c => c.type));
    for (const change of changes) {
      const key = attrKey(change.type);
      const existing = entry.attributes.get(key) ?? [];
      if (change.op === 'replace') {
        if (change.values.length === 0) entry.attributes.delete(key);
        else entry.attributes.set(key, [...change.values]);
      } else if (change.op === 'add') {
        const merged = [...existing];
        for (const v of change.values) if (!merged.some(e => e.toLowerCase() === v.toLowerCase())) merged.push(v);
        entry.attributes.set(key, merged);
      } else { // delete
        if (change.values.length === 0) { entry.attributes.delete(key); continue; }
        const remaining = existing.filter(e => !change.values.some(v => v.toLowerCase() === e.toLowerCase()));
        if (remaining.length === 0) entry.attributes.delete(key);
        else entry.attributes.set(key, remaining);
      }
      if (key === MEMBER_ATTRIBUTE) {
        this.syncBackLinks(entry, existing, entry.attributes.get(key) ?? []);
      }
    }
    if (this.replication) entry.replMeta = this.stampFor(entry.replMeta);
    return { ok: true, message: '' };
  }

  private syncBackLinks(group: DirectoryEntry, before: readonly string[], after: readonly string[]): void {
    const groupDn = formatDN(group.dn);
    const lower = (list: readonly string[]) => new Set(list.map(v => v.toLowerCase()));
    const had = lower(before);
    const has = lower(after);
    for (const value of after) {
      if (had.has(value.toLowerCase())) continue;
      this.writeBackLink(value, groupDn, 'add');
    }
    for (const value of before) {
      if (has.has(value.toLowerCase())) continue;
      this.writeBackLink(value, groupDn, 'delete');
    }
  }

  private writeBackLink(memberDn: string, groupDn: string, op: 'add' | 'delete'): void {
    let dn: DistinguishedName;
    try { dn = parseDN(memberDn); } catch { return; }
    const member = this.getByDn(dn);
    if (!member) return;
    const existing = member.attributes.get(MEMBER_OF_ATTRIBUTE) ?? [];
    const next = op === 'add'
      ? (existing.some(v => v.toLowerCase() === groupDn.toLowerCase()) ? existing : [...existing, groupDn])
      : existing.filter(v => v.toLowerCase() !== groupDn.toLowerCase());
    if (next.length === 0) member.attributes.delete(MEMBER_OF_ATTRIBUTE);
    else member.attributes.set(MEMBER_OF_ATTRIBUTE, next);
    this.rememberAttributeNames([MEMBER_OF_ATTRIBUTE]);
    if (op === 'delete') this.linkDeadlines.delete(linkIndexKey(groupDn, memberDn));
  }

  /** Every entry whose replication stamp is newer than what `vector` already reflects for its originating DC — what a replication partner pulling from this tree hasn't seen yet (PRD-Windows-Server-Advanced.md §5 P4). No-op (`[]`) on a non-replicating tree. */
  changedSince(vector: HighWatermarkVector): DirectoryEntry[] {
    return this.allDescendants(this.root.dn).filter((e) => {
      if (!e.replMeta) return false;
      return e.replMeta.originatingUsn > (vector.usnByInvocationId.get(e.replMeta.originatingInvocationId) ?? 0);
    });
  }

  /**
   * Writes a peer DC's own version of an entry, preserving its
   * originating stamp (never re-stamped as a local write) — last-writer-
   * wins by timestamp if the entry already exists locally. Creates the
   * entry if absent (silently skipped if its parent hasn't replicated
   * yet — picked up on a later cycle, same as MS-DRSR's linked-attribute
   * convergence-over-multiple-cycles behavior). Deletions are not
   * replicated (no tombstones modeled, per PRD §2.2 scope).
   */
  applyReplicatedEntry(dn: DistinguishedName, attributes: Record<string, string[]>, stamp: EntryReplMeta): void {
    const existing = this.getByDn(dn);
    if (existing) {
      if (existing.replMeta && localWins(existing.replMeta, stamp)) return;
      existing.attributes.clear();
      for (const [k, v] of toAttrMap(attributes)) existing.attributes.set(k, v);
      existing.replMeta = stamp;
      return;
    }
    const parentDn = parentOf(dn);
    const parent = parentDn ? this.getByDn(parentDn) : null;
    if (!parent) return;
    const entry: DirectoryEntry = { dn, attributes: toAttrMap(attributes), children: new Map(), replMeta: stamp };
    parent.children.set(rdnKey(dn), entry);
    this.byDn.set(this.dnIndexKey(dn), entry);
  }

  /**
   * RFC 4511 §4.9 ModifyDNRequest — renames `dn` to `newRdnStr`, optionally
   * moving it under `newSuperior` and/or stripping the old RDN's
   * attribute values (`deleteOldRdn`). Every descendant's DN embeds this
   * entry's own DN, so they're all rewritten too.
   */
  renameEntry(dn: DistinguishedName, newRdnStr: string, deleteOldRdn: boolean, newSuperior?: DistinguishedName): TreeOpResult {
    const entry = this.getByDn(dn);
    if (!entry) return { ok: false, message: 'noSuchObject' };
    const oldParentDn = parentOf(dn);
    const oldParent = oldParentDn ? this.getByDn(oldParentDn) : null;
    if (!oldParent || !oldParentDn) return { ok: false, message: 'noSuchObject: parent does not exist' };

    const targetParentDn = newSuperior ?? oldParentDn;
    const targetParent = newSuperior ? this.getByDn(newSuperior) : oldParent;
    if (!targetParent) return { ok: false, message: 'noSuchObject: new superior does not exist' };

    let newRdn: Rdn;
    try {
      const parsed = parseDN(newRdnStr);
      if (parsed.length !== 1) throw new Error('not a single RDN');
      newRdn = parsed[0];
    } catch {
      return { ok: false, message: 'invalidDNSyntax' };
    }

    const newDn: DistinguishedName = [newRdn, ...targetParentDn];
    if (!dnEquals(newDn, dn) && this.getByDn(newDn)) return { ok: false, message: 'entryAlreadyExists' };

    if (deleteOldRdn) {
      for (const ava of dn[0]) {
        const key = attrKey(ava.type);
        const remaining = (entry.attributes.get(key) ?? []).filter(v => v.toLowerCase() !== ava.value.toLowerCase());
        if (remaining.length === 0) entry.attributes.delete(key);
        else entry.attributes.set(key, remaining);
      }
    }
    for (const ava of newRdn) {
      const key = attrKey(ava.type);
      const existing = entry.attributes.get(key) ?? [];
      if (!existing.some(v => v.toLowerCase() === ava.value.toLowerCase())) entry.attributes.set(key, [...existing, ava.value]);
    }

    oldParent.children.delete(rdnKey(dn));
    this.reindexSubtree(entry, dn, newDn);
    targetParent.children.set(rdnKey(newDn), entry);
    if (this.replication) entry.replMeta = this.stampFor(entry.replMeta);
    return { ok: true, message: '' };
  }

  /** Rewrites `entry`'s own DN plus every descendant's — each keeps whatever RDN chain it had *above* `oldBase`, now rooted at `newBase` instead — and reindexes `byDn` to match. */
  private reindexSubtree(entry: DirectoryEntry, oldBase: DistinguishedName, newBase: DistinguishedName): void {
    const rewrite = (e: DirectoryEntry): void => {
      this.byDn.delete(this.dnIndexKey(e.dn));
      const suffix = e.dn.slice(0, e.dn.length - oldBase.length);
      const newEntryDn = [...suffix, ...newBase];
      (e as unknown as { dn: DistinguishedName }).dn = newEntryDn;
      this.byDn.set(this.dnIndexKey(newEntryDn), e);
      for (const child of e.children.values()) rewrite(child);
    };
    rewrite(entry);
  }

  /** RFC 4511 §4.5 SearchRequest — real scope + filter evaluation over the tree. */
  search(baseDn: DistinguishedName, scope: SearchScope, filter: LdapFilter): DirectoryEntry[] {
    const base = this.getByDn(baseDn);
    if (!base) return [];
    const candidates: DirectoryEntry[] = [];
    if (scope === 'base') {
      candidates.push(base);
    } else if (scope === 'one') {
      candidates.push(...base.children.values());
    } else {
      const walk = (e: DirectoryEntry): void => {
        candidates.push(e);
        for (const c of e.children.values()) walk(c);
      };
      walk(base);
    }
    return candidates.filter(e => evaluateFilter(filter, entryAttributeSource(e)));
  }

  /** RFC 4511 §4.10 CompareRequest. */
  compare(dn: DistinguishedName, attr: string, value: string): 'true' | 'false' | 'noSuchObject' {
    const entry = this.getByDn(dn);
    if (!entry) return 'noSuchObject';
    const values = entry.attributes.get(attrKey(attr)) ?? [];
    return values.some(v => v.toLowerCase() === value.toLowerCase()) ? 'true' : 'false';
  }

  /** All entries anywhere under (and including) `dn`, depth-first — a convenience for callers outside SearchRequest semantics. */
  allDescendants(dn: DistinguishedName): DirectoryEntry[] {
    const base = this.getByDn(dn);
    if (!base) return [];
    const out: DirectoryEntry[] = [];
    const walk = (e: DirectoryEntry): void => { out.push(e); for (const c of e.children.values()) walk(c); };
    walk(base);
    return out;
  }

  isWithinTree(dn: DistinguishedName): boolean {
    return dnEquals(dn, this.root.dn) || isDescendantOf(dn, this.root.dn);
  }
}

function toAttrMap(attributes: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(attributes).map(([k, v]) => [attrKey(k), [...v]]));
}
