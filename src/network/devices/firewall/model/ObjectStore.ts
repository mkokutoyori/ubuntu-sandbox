import {
  addressObjectMatches,
  anyAddress,
  type AddressMatchContext,
  type AddressObject,
} from './AddressObject';
import {
  anyService,
  serviceObjectMatches,
  type ServiceObject,
  type ServiceProbe,
} from './ServiceObject';

export type ObjectKind = 'address' | 'service';

export interface ObjectGroup {
  readonly name: string;
  readonly kind: ObjectKind;
  readonly members: readonly string[];
  readonly comment?: string;
}

export type ObjectError =
  | { kind: 'duplicate-name'; name: string }
  | { kind: 'unknown-object'; name: string }
  | { kind: 'unknown-member'; group: string; member: string }
  | { kind: 'recursive-group'; group: string; member: string }
  | { kind: 'nesting-too-deep'; group: string; limit: number }
  | { kind: 'object-referenced'; name: string; referents: readonly string[] }
  | { kind: 'predefined-object'; name: string };

export type ObjectMutation = { ok: true } | { ok: false; error: ObjectError };

const OBJECT_OK: ObjectMutation = Object.freeze({ ok: true as const });

function failure(error: ObjectError): ObjectMutation {
  return Object.freeze({ ok: false as const, error: Object.freeze(error) });
}

export interface ObjectStoreDeps {
  maxGroupNesting?: number;
  resolveFqdn?: (fqdn: string) => readonly string[];
  countryOf?: (ip: string) => string | undefined;
  addressesWithTags?: (filter: string) => readonly string[];
  externalReferences?: (name: string) => readonly string[];
}

interface GroupRecord {
  name: string;
  kind: ObjectKind;
  members: string[];
  comment?: string;
}

const DEFAULT_MAX_NESTING = 8;

export class ObjectStore {
  private readonly addresses = new Map<string, AddressObject>();
  private readonly services = new Map<string, ServiceObject>();
  private readonly addressGroups = new Map<string, GroupRecord>();
  private readonly serviceGroups = new Map<string, GroupRecord>();
  private readonly deps: ObjectStoreDeps;
  private readonly maxNesting: number;

  constructor(deps: ObjectStoreDeps = {}) {
    this.deps = deps;
    this.maxNesting = deps.maxGroupNesting ?? DEFAULT_MAX_NESTING;
    this.addresses.set('any', anyAddress());
    this.services.set('any', anyService());
  }

  // ─── Addresses ──────────────────────────────────────────────────

  addAddress(object: AddressObject): ObjectMutation {
    if (this.addressNameTaken(object.name)) return failure({ kind: 'duplicate-name', name: object.name });
    this.addresses.set(object.name, object);
    return OBJECT_OK;
  }

  upsertAddress(object: AddressObject): ObjectMutation {
    if (this.addressGroups.has(object.name)) {
      return failure({ kind: 'duplicate-name', name: object.name });
    }
    if (this.addresses.get(object.name)?.predefined) {
      return failure({ kind: 'predefined-object', name: object.name });
    }
    this.addresses.set(object.name, object);
    return OBJECT_OK;
  }

  getAddress(name: string): AddressObject | undefined {
    return this.addresses.get(name);
  }

  removeAddress(name: string): ObjectMutation {
    const object = this.addresses.get(name);
    if (!object) return failure({ kind: 'unknown-object', name });
    if (object.predefined) return failure({ kind: 'predefined-object', name });
    return this.removeIfUnreferenced(name, () => this.addresses.delete(name));
  }

  listAddresses(options: { includePredefined?: boolean } = {}): readonly AddressObject[] {
    const include = options.includePredefined ?? true;
    return Object.freeze([...this.addresses.values()].filter(o => include || !o.predefined));
  }

  // ─── Services ───────────────────────────────────────────────────

  addService(object: ServiceObject): ObjectMutation {
    if (this.serviceNameTaken(object.name)) return failure({ kind: 'duplicate-name', name: object.name });
    this.services.set(object.name, object);
    return OBJECT_OK;
  }

  getService(name: string): ServiceObject | undefined {
    return this.services.get(name);
  }

  removeService(name: string): ObjectMutation {
    const object = this.services.get(name);
    if (!object) return failure({ kind: 'unknown-object', name });
    if (object.predefined) return failure({ kind: 'predefined-object', name });
    return this.removeIfUnreferenced(name, () => this.services.delete(name));
  }

  listServices(options: { includePredefined?: boolean } = {}): readonly ServiceObject[] {
    const include = options.includePredefined ?? true;
    return Object.freeze([...this.services.values()].filter(o => include || !o.predefined));
  }

  // ─── Groups ─────────────────────────────────────────────────────

  addAddressGroup(name: string, members: readonly string[], comment?: string): ObjectMutation {
    return this.addGroup(this.addressGroups, 'address', name, members, comment);
  }

  addServiceGroup(name: string, members: readonly string[], comment?: string): ObjectMutation {
    return this.addGroup(this.serviceGroups, 'service', name, members, comment);
  }

  getAddressGroup(name: string): ObjectGroup | undefined {
    return freezeGroup(this.addressGroups.get(name));
  }

  getServiceGroup(name: string): ObjectGroup | undefined {
    return freezeGroup(this.serviceGroups.get(name));
  }

  listAddressGroups(): readonly ObjectGroup[] {
    return Object.freeze([...this.addressGroups.values()].map(g => freezeGroup(g)!));
  }

  listServiceGroups(): readonly ObjectGroup[] {
    return Object.freeze([...this.serviceGroups.values()].map(g => freezeGroup(g)!));
  }

  removeAddressGroup(name: string): ObjectMutation {
    if (!this.addressGroups.has(name)) return failure({ kind: 'unknown-object', name });
    return this.removeIfUnreferenced(name, () => this.addressGroups.delete(name));
  }

  removeServiceGroup(name: string): ObjectMutation {
    if (!this.serviceGroups.has(name)) return failure({ kind: 'unknown-object', name });
    return this.removeIfUnreferenced(name, () => this.serviceGroups.delete(name));
  }

  addGroupMember(groupName: string, member: string): ObjectMutation {
    const group = this.addressGroups.get(groupName) ?? this.serviceGroups.get(groupName);
    if (!group) return failure({ kind: 'unknown-object', name: groupName });
    if (!this.memberExists(group.kind, member)) {
      return failure({ kind: 'unknown-member', group: groupName, member });
    }
    if (this.wouldRecurse(group.kind, groupName, member)) {
      return failure({ kind: 'recursive-group', group: groupName, member });
    }
    if (!group.members.includes(member)) group.members.push(member);
    return OBJECT_OK;
  }

  removeGroupMember(groupName: string, member: string): ObjectMutation {
    const group = this.addressGroups.get(groupName) ?? this.serviceGroups.get(groupName);
    if (!group) return failure({ kind: 'unknown-object', name: groupName });
    group.members = group.members.filter(m => m !== member);
    return OBJECT_OK;
  }

  // ─── Matching ───────────────────────────────────────────────────

  matchesAddress(name: string, candidate: string): boolean {
    return this.matchAddressWithDepth(name, candidate, 0, new Set());
  }

  matchesAnyAddress(names: readonly string[], candidate: string): boolean {
    return names.some(name => this.matchesAddress(name, candidate));
  }

  namesVipRule(names: readonly string[], natRuleId: string): boolean {
    return names.some(name => this.reachesVipRule(name, natRuleId, 0, new Set()));
  }

  private reachesVipRule(
    name: string, natRuleId: string, depth: number, seen: Set<string>,
  ): boolean {
    if (depth > this.maxNesting || seen.has(name)) return false;
    seen.add(name);

    if (this.addresses.get(name)?.natRuleId === natRuleId) return true;

    const group = this.addressGroups.get(name);
    if (!group) return false;
    return group.members.some(
      member => this.reachesVipRule(member, natRuleId, depth + 1, seen));
  }

  matchesService(name: string, probe: ServiceProbe): boolean {
    return this.serviceMatching([name], probe) !== undefined;
  }

  matchesAnyService(names: readonly string[], probe: ServiceProbe): boolean {
    return this.serviceMatching(names, probe) !== undefined;
  }

  serviceMatching(
    names: readonly string[], probe: ServiceProbe,
  ): ServiceObject | undefined {
    for (const name of names) {
      const matched = this.matchServiceWithDepth(name, probe, 0, new Set());
      if (matched) return matched;
    }
    return undefined;
  }

  // ─── References ─────────────────────────────────────────────────

  referenceCount(name: string): number {
    return this.referentsOf(name).length;
  }

  referentsOf(name: string): readonly string[] {
    const referents: string[] = [];
    for (const group of this.addressGroups.values()) {
      if (group.name !== name && group.members.includes(name)) referents.push(`address-group ${group.name}`);
    }
    for (const group of this.serviceGroups.values()) {
      if (group.name !== name && group.members.includes(name)) referents.push(`service-group ${group.name}`);
    }
    referents.push(...(this.deps.externalReferences?.(name) ?? []));
    return Object.freeze(referents);
  }

  // ─── Internals ──────────────────────────────────────────────────

  private matchContext(): AddressMatchContext {
    return {
      resolveFqdn: this.deps.resolveFqdn,
      countryOf: this.deps.countryOf,
      addressesWithTags: this.deps.addressesWithTags,
    };
  }

  private matchAddressWithDepth(
    name: string, candidate: string, depth: number, seen: Set<string>,
  ): boolean {
    if (depth > this.maxNesting || seen.has(name)) return false;

    const object = this.addresses.get(name);
    if (object) return addressObjectMatches(object, candidate, this.matchContext());

    const group = this.addressGroups.get(name);
    if (!group) return false;

    seen.add(name);
    const matched = group.members.some(
      member => this.matchAddressWithDepth(member, candidate, depth + 1, seen));
    seen.delete(name);
    return matched;
  }

  private matchServiceWithDepth(
    name: string, probe: ServiceProbe, depth: number, seen: Set<string>,
  ): ServiceObject | undefined {
    if (depth > this.maxNesting || seen.has(name)) return undefined;

    const object = this.services.get(name);
    if (object) return serviceObjectMatches(object, probe) ? object : undefined;

    const group = this.serviceGroups.get(name);
    if (!group) return undefined;

    seen.add(name);
    let matched: ServiceObject | undefined;
    for (const member of group.members) {
      matched = this.matchServiceWithDepth(member, probe, depth + 1, seen);
      if (matched) break;
    }
    seen.delete(name);
    return matched;
  }

  private addGroup(
    into: Map<string, GroupRecord>, kind: ObjectKind,
    name: string, members: readonly string[], comment?: string,
  ): ObjectMutation {
    if (kind === 'address' ? this.addressNameTaken(name) : this.serviceNameTaken(name)) {
      return failure({ kind: 'duplicate-name', name });
    }
    for (const member of members) {
      if (!this.memberExists(kind, member)) return failure({ kind: 'unknown-member', group: name, member });
    }

    into.set(name, { name, kind, members: [...members], comment });

    const depth = this.depthOf(kind, name, 0, new Set());
    if (depth > this.maxNesting) {
      into.delete(name);
      return failure({ kind: 'nesting-too-deep', group: name, limit: this.maxNesting });
    }
    return OBJECT_OK;
  }

  private memberExists(kind: ObjectKind, member: string): boolean {
    return kind === 'address'
      ? this.addresses.has(member) || this.addressGroups.has(member)
      : this.services.has(member) || this.serviceGroups.has(member);
  }

  private addressNameTaken(name: string): boolean {
    return this.addresses.has(name) || this.addressGroups.has(name);
  }

  private serviceNameTaken(name: string): boolean {
    return this.services.has(name) || this.serviceGroups.has(name);
  }

  private groupsFor(kind: ObjectKind): Map<string, GroupRecord> {
    return kind === 'address' ? this.addressGroups : this.serviceGroups;
  }

  private wouldRecurse(kind: ObjectKind, groupName: string, member: string): boolean {
    if (member === groupName) return true;
    return this.reaches(kind, member, groupName, new Set());
  }

  private reaches(kind: ObjectKind, from: string, target: string, seen: Set<string>): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);

    const group = this.groupsFor(kind).get(from);
    if (!group) return false;
    return group.members.some(member => this.reaches(kind, member, target, seen));
  }

  private depthOf(kind: ObjectKind, name: string, depth: number, seen: Set<string>): number {
    if (seen.has(name) || depth > this.maxNesting) return depth;
    const group = this.groupsFor(kind).get(name);
    if (!group) return depth;

    seen.add(name);
    let deepest = depth;
    for (const member of group.members) {
      deepest = Math.max(deepest, this.depthOf(kind, member, depth + 1, seen));
    }
    seen.delete(name);
    return deepest;
  }

  private removeIfUnreferenced(name: string, remove: () => void): ObjectMutation {
    const referents = this.referentsOf(name);
    if (referents.length > 0) return failure({ kind: 'object-referenced', name, referents });
    remove();
    return OBJECT_OK;
  }
}

function freezeGroup(group: GroupRecord | undefined): ObjectGroup | undefined {
  if (!group) return undefined;
  return Object.freeze({
    name: group.name,
    kind: group.kind,
    members: Object.freeze([...group.members]),
    comment: group.comment,
  });
}
