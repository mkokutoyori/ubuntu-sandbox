/**
 * DirectoryTree — a real LDAP Directory Information Tree (DIT): entries
 * keyed by DN, each holding a real multi-valued attribute map, organized
 * as a parent/child tree matching the DN hierarchy. This is the engine
 * `LdapServer` operates on for real Add/Search/Modify/Delete/Compare —
 * not a flat lookup table with cosmetic DN strings.
 */

import {
  type DistinguishedName, type Rdn, parseDN, dnEquals, parentOf, isDescendantOf,
} from './LdapDN';
import { type LdapFilter, type AttributeSource, evaluateFilter } from './LdapFilter';
import type { HighWatermarkVector } from '../replication/HighWatermarkVector';
import type { SchemaValidator } from '../schema/SchemaValidator';

/**
 * Multi-DC replication stamp (PRD-Windows-Server-Advanced.md §5 P4,
 * inspired by MS-DRSR's per-attribute `msDS-ReplAttributeMetadata`):
 * one stamp per attribute, keyed by lowercase attribute name, rather than
 * one stamp for the whole object — so two DCs concurrently changing
 * *different* attributes on the same object each keep their own change
 * on merge, instead of one write silently clobbering the other. Still
 * simplified vs real AD: no tombstones/USN rollback modeled (per PRD
 * §2.2 scope).
 *
 * `version` (matching real AD's own field name) is the primary conflict
 * key, not `timestamp`: it starts at 1 when an attribute is first set and
 * increments by 1 on every subsequent write to that same attribute,
 * whether local or adopted via replication — a DC that adopts a
 * replicated value's `version` continues incrementing from it on its own
 * next local write. This stays correct regardless of wall-clock
 * resolution, which real-time-driven `timestamp` alone cannot guarantee
 * once two DCs write different attributes within the same clock tick (as
 * happens routinely in a simulator with no real network latency).
 * `timestamp` only breaks a tie between two writes that both produced the
 * same `version` for the same attribute without ever replicating between
 * each other first (a genuine simultaneous-origination conflict).
 */
export interface AttributeReplStamp {
  readonly originatingInvocationId: string;
  readonly originatingUsn: number;
  readonly version: number;
  readonly timestamp: number; // epoch seconds — final tiebreak only, when `version` itself ties
}

export type EntryReplMeta = Map<string, AttributeReplStamp>;

/** JSON-serializable form for the replication wire protocol (a `Map` doesn't survive `JSON.stringify` directly — same convention as `HighWatermarkVectorWire`). */
export type EntryReplMetaWire = [string, AttributeReplStamp][];

export function encodeEntryReplMeta(meta: EntryReplMeta): EntryReplMetaWire {
  return [...meta.entries()];
}

export function decodeEntryReplMeta(wire: EntryReplMetaWire): EntryReplMeta {
  return new Map(wire);
}

/** Supplied by a replicating `DirectoryStore` so every local write is auto-stamped; absent (`undefined`) for any `DirectoryTree` that doesn't participate in replication (e.g. the LDAP wire-protocol unit tests), which never touch `replMeta`. */
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

  constructor(
    baseDn: string | DistinguishedName,
    rootAttributes: Record<string, string[]> = {},
    private readonly replication?: ReplicationIdentity,
    /** RFC 4512 schema validation (PRD-Windows-Server-Advanced.md §5 P7) — absent on any `DirectoryTree` with no schema partition (e.g. the LDAP wire-protocol unit tests), which behaves exactly as before this phase. */
    private readonly schema?: SchemaValidator,
    /** An RODC's replica (MS-ADTS §3.1.1.1.11): refuses every local/LDAP-originated write (`addEntry`/`modifyEntry`/`deleteEntry`/`renameEntry`) with `unwillingToPerform`, same as real AD — `applyReplicatedEntry` is deliberately exempt, since an RODC still absorbs a full (filtered) copy of the directory via ordinary replication. */
    private readonly readOnly = false,
  ) {
    const dn = typeof baseDn === 'string' ? parseDN(baseDn) : baseDn;
    this.root = { dn, attributes: toAttrMap(rootAttributes), children: new Map(), replMeta: null };
    this.stampKeys(this.root, this.root.attributes.keys());
    this.byDn.set(this.dnIndexKey(dn), this.root);
  }

  /** Stamps every key in `keys` with one freshly allocated write (same originating USN/timestamp across all of them — one LDAP operation, one USN, matching real AD's `usnChanged`; `version` is per-key, continuing from whatever that specific attribute already carried). No-op on a non-replicating tree. */
  private stampKeys(entry: DirectoryEntry, keys: Iterable<string>): void {
    if (!this.replication) return;
    const originatingInvocationId = this.replication.invocationId;
    const originatingUsn = this.replication.nextUsn();
    const timestamp = Math.floor(Date.now() / 1000);
    if (!entry.replMeta) entry.replMeta = new Map();
    for (const key of keys) {
      const priorVersion = entry.replMeta.get(key)?.version ?? 0;
      entry.replMeta.set(key, { originatingInvocationId, originatingUsn, version: priorVersion + 1, timestamp });
    }
  }

  /** Canonical index key: each RDN's AVAs sorted+lowercased, so order-independent multi-valued RDNs (RFC 4514 §2.3) index identically — matches `dnEquals`. */
  private dnIndexKey(dn: DistinguishedName): string { return dn.map(rdnCanonicalKey).join(','); }

  getRootDn(): DistinguishedName { return this.root.dn; }

  getByDn(dn: DistinguishedName): DirectoryEntry | null {
    return this.byDn.get(this.dnIndexKey(dn)) ?? null;
  }

  /** `unwillingToPerform` on an RODC's replica, `null` otherwise — checked first by every write operation. */
  private refuseIfReadOnly(): TreeOpResult | null {
    return this.readOnly ? { ok: false, message: 'unwillingToPerform: this DC hosts a read-only directory replica' } : null;
  }

  /**
   * RFC 4511 §4.6 AddRequest — fails with entryAlreadyExists / noSuchObject
   * (missing parent) / objectClassViolation (RFC 4512 schema, §5 P7 — only
   * for `objectClass` values that have a registered `classSchema`;
   * permissive for everything else). `bypassReadOnly` exists for exactly
   * one caller — an RODC creating its own computer account during
   * promotion (MS-ADTS §3.1.1.1.11's own bootstrap, distinct from ordinary
   * directory writes real AD also keeps separate) — never reachable from
   * LDAP or any AD cmdlet.
   */
  addEntry(dn: DistinguishedName, attributes: Record<string, string[]>, opts: { bypassReadOnly?: boolean } = {}): TreeOpResult {
    if (!opts.bypassReadOnly) {
      const refusal = this.refuseIfReadOnly();
      if (refusal) return refusal;
    }
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
    const entry: DirectoryEntry = { dn, attributes: toAttrMap(attributes), children: new Map(), replMeta: null };
    this.stampKeys(entry, entry.attributes.keys());
    parent.children.set(rdnKey(dn), entry);
    this.byDn.set(this.dnIndexKey(dn), entry);
    return { ok: true, message: '' };
  }

  /** RFC 4511 §4.8 DelRequest — real AD (and this tree) refuses to delete a non-leaf entry. */
  deleteEntry(dn: DistinguishedName): TreeOpResult {
    const refusal = this.refuseIfReadOnly();
    if (refusal) return refusal;
    const entry = this.getByDn(dn);
    if (!entry) return { ok: false, message: 'noSuchObject' };
    if ((entry.attributes.get('protectedfromaccidentaldeletion') ?? [])[0] === 'true') {
      return { ok: false, message: 'accessDenied: object is protected from accidental deletion' };
    }
    if (entry.children.size > 0) return { ok: false, message: 'notAllowedOnNonLeaf' };
    const parentDn = parentOf(dn);
    const parent = parentDn ? this.getByDn(parentDn) : null;
    parent?.children.delete(rdnKey(dn));
    this.byDn.delete(this.dnIndexKey(dn));
    return { ok: true, message: '' };
  }

  /** RFC 4511 §4.6 ModifyRequest — add/delete/replace on one or more attribute types. */
  modifyEntry(dn: DistinguishedName, changes: readonly Modification[]): TreeOpResult {
    const refusal = this.refuseIfReadOnly();
    if (refusal) return refusal;
    const entry = this.getByDn(dn);
    if (!entry) return { ok: false, message: 'noSuchObject' };
    const touchedKeys = new Set<string>();
    for (const change of changes) {
      const key = attrKey(change.type);
      touchedKeys.add(key);
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
    }
    this.stampKeys(entry, touchedKeys);
    return { ok: true, message: '' };
  }

  /** Every entry with at least one attribute whose stamp is newer than what `vector` already reflects for its originating DC — what a replication partner pulling from this tree hasn't seen yet (PRD-Windows-Server-Advanced.md §5 P4). No-op (`[]`) on a non-replicating tree. */
  changedSince(vector: HighWatermarkVector): DirectoryEntry[] {
    return this.allDescendants(this.root.dn).filter((e) => {
      if (!e.replMeta) return false;
      for (const stamp of e.replMeta.values()) {
        if (stamp.originatingUsn > (vector.usnByInvocationId.get(stamp.originatingInvocationId) ?? 0)) return true;
      }
      return false;
    });
  }

  /**
   * Merges a peer DC's version of an entry attribute-by-attribute —
   * each attribute wins on its own stamp (last-writer-wins by timestamp,
   * same tiebreak as before) rather than the whole object winning or
   * losing as one unit. This is what lets two DCs concurrently modify
   * *different* attributes on the same object without one clobbering the
   * other's change once they replicate. Creates the entry if absent
   * (silently skipped if its parent hasn't replicated yet — picked up on
   * a later cycle, same as MS-DRSR's linked-attribute convergence-over-
   * multiple-cycles behavior). Deletions are not replicated (no
   * tombstones modeled, per PRD §2.2 scope).
   */
  applyReplicatedEntry(dn: DistinguishedName, attributes: Record<string, string[]>, incomingMeta: EntryReplMeta): void {
    const existing = this.getByDn(dn);
    if (existing) {
      if (!existing.replMeta) existing.replMeta = new Map();
      for (const [key, incomingStamp] of incomingMeta) {
        const currentStamp = existing.replMeta.get(key);
        if (currentStamp && !incomingAttributeWins(currentStamp, incomingStamp)) continue;
        const values = attributes[key];
        if (values && values.length > 0) existing.attributes.set(key, [...values]);
        else existing.attributes.delete(key);
        existing.replMeta.set(key, incomingStamp);
      }
      return;
    }
    const parentDn = parentOf(dn);
    const parent = parentDn ? this.getByDn(parentDn) : null;
    if (!parent) return;
    const entry: DirectoryEntry = { dn, attributes: toAttrMap(attributes), children: new Map(), replMeta: new Map(incomingMeta) };
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
    const refusal = this.refuseIfReadOnly();
    if (refusal) return refusal;
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

    const touchedKeys = new Set<string>();
    if (deleteOldRdn) {
      for (const ava of dn[0]) {
        const key = attrKey(ava.type);
        touchedKeys.add(key);
        const remaining = (entry.attributes.get(key) ?? []).filter(v => v.toLowerCase() !== ava.value.toLowerCase());
        if (remaining.length === 0) entry.attributes.delete(key);
        else entry.attributes.set(key, remaining);
      }
    }
    for (const ava of newRdn) {
      const key = attrKey(ava.type);
      touchedKeys.add(key);
      const existing = entry.attributes.get(key) ?? [];
      if (!existing.some(v => v.toLowerCase() === ava.value.toLowerCase())) entry.attributes.set(key, [...existing, ava.value]);
    }

    oldParent.children.delete(rdnKey(dn));
    this.reindexSubtree(entry, dn, newDn);
    targetParent.children.set(rdnKey(newDn), entry);
    this.stampKeys(entry, touchedKeys);
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

/** Higher `version` always wins; `timestamp` (then, for full determinism, `originatingInvocationId`) only breaks a tie when both sides reached the same `version` without ever replicating between each other. */
function incomingAttributeWins(current: AttributeReplStamp, incoming: AttributeReplStamp): boolean {
  if (incoming.version !== current.version) return incoming.version > current.version;
  if (incoming.timestamp !== current.timestamp) return incoming.timestamp > current.timestamp;
  return incoming.originatingInvocationId > current.originatingInvocationId;
}
