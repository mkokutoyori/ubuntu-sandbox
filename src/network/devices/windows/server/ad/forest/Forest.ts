/**
 * Forest — multi-domain forest metadata (PRD-Windows-Server-Advanced.md
 * §5 P8): a parent/child tree of domains sharing one schema partition.
 *
 * Real AD shares the Schema/Configuration naming context forest-wide via
 * replication (§5 P4) — it's a genuinely separate partition from any
 * domain's own directory. This simulator gives each domain exactly one
 * `DirectoryTree` (no separate NCs), so there is no cross-domain-tree
 * replication path to reuse for Schema/Configuration specifically.
 * Building one just for this would be a second, parallel replication
 * mechanism — which the PRD's own framing ("le partage ... se réalise
 * sans mécanisme supplémentaire") explicitly steers away from. Instead,
 * a forest's `SchemaValidator` (the actual mustContain/mayContain
 * enforcement engine, §5 P7) is shared *by reference* across every
 * domain's `DirectoryStore` in the forest — this in-process registry is
 * what stands in for Configuration NC replication: a schema change
 * registered through any domain's `New-ADAttribute`/`New-ADObjectClass`
 * is immediately enforced when creating objects in every other domain of
 * the same forest, matching real AD's observable behavior even though
 * the mechanism underneath is simplified.
 */
import type { SchemaValidator } from '../schema/SchemaValidator';
import { DEFAULT_AD_FUNCTIONAL_LEVEL } from '../adFunctionalLevels';

export interface ForestDomain {
  readonly dnsName: string;
  readonly netbiosName: string;
  readonly parentDnsName?: string;
}

export interface ForestOpResult { ok: boolean; message: string }

/** The 2 forest-wide FSMO roles (RFC-less, but real AD terminology) — the other 3 (RID/PDC Emulator/Infrastructure Master) are per-domain, tracked on each domain's own DirectoryStore instead. */
export interface ForestFsmoRoles {
  schemaMaster: string;
  domainNamingMaster: string;
}

export class Forest {
  functionalLevel: string = DEFAULT_AD_FUNCTIONAL_LEVEL.forestMode;
  private readonly domains = new Map<string, ForestDomain>();
  private fsmo: ForestFsmoRoles | null = null;

  addDomain(domain: ForestDomain): ForestOpResult {
    const key = domain.dnsName.toLowerCase();
    if (this.domains.has(key)) {
      return { ok: false, message: `A domain named "${domain.dnsName}" already exists in this forest.` };
    }
    if (domain.parentDnsName && !this.domains.has(domain.parentDnsName.toLowerCase())) {
      return { ok: false, message: `Cannot find a parent domain named "${domain.parentDnsName}" in this forest.` };
    }
    this.domains.set(key, domain);
    return { ok: true, message: '' };
  }

  listDomains(): ForestDomain[] { return [...this.domains.values()]; }
  getRootDomain(): ForestDomain | null { return this.listDomains().find(d => !d.parentDnsName) ?? null; }

  /** Both forest-wide FSMO roles start on the forest's founding DC (`Install-ADDSForest`'s own DC) — call once, at forest creation. */
  initializeFsmoRoles(foundingDcHostname: string): void {
    if (this.fsmo) return;
    this.fsmo = { schemaMaster: foundingDcHostname, domainNamingMaster: foundingDcHostname };
  }

  getFsmoRoles(): ForestFsmoRoles {
    return this.fsmo ?? { schemaMaster: '', domainNamingMaster: '' };
  }

  transferFsmoRole(role: keyof ForestFsmoRoles, newOwnerHostname: string): void {
    if (!this.fsmo) return;
    this.fsmo[role] = newOwnerHostname;
  }
}

interface ForestRegistration { forest: Forest; schemaValidator: SchemaValidator }

/** Every known domain (root or child), keyed by its own DNS name, pointing at the one shared `Forest`/`SchemaValidator` pair for its forest. */
const domainToForest = new Map<string, ForestRegistration>();

function key(dnsName: string): string { return dnsName.toLowerCase(); }

/** `Install-ADDSForest` — the first domain of a brand-new forest. */
export function createForest(rootDnsName: string, rootNetbiosName: string, schemaValidator: SchemaValidator, forestMode?: string): Forest {
  const forest = new Forest();
  if (forestMode) forest.functionalLevel = forestMode;
  forest.addDomain({ dnsName: rootDnsName, netbiosName: rootNetbiosName });
  domainToForest.set(key(rootDnsName), { forest, schemaValidator });
  return forest;
}

/** `New-ADDomain -ParentDomainName` — joins a new child domain to `parentDnsName`'s forest, returning the forest's shared `SchemaValidator` for the new `DirectoryStore` to use. */
export function joinForestAsChildDomain(
  parentDnsName: string, childDnsName: string, childNetbiosName: string,
): ForestOpResult & { schemaValidator?: SchemaValidator } {
  const registration = domainToForest.get(key(parentDnsName));
  if (!registration) return { ok: false, message: `Cannot find a domain named "${parentDnsName}".` };
  const res = registration.forest.addDomain({ dnsName: childDnsName, netbiosName: childNetbiosName, parentDnsName });
  if (!res.ok) return res;
  domainToForest.set(key(childDnsName), registration);
  return { ok: true, message: '', schemaValidator: registration.schemaValidator };
}

export function getForestForDomain(dnsName: string): Forest | null {
  return domainToForest.get(key(dnsName))?.forest ?? null;
}

/** Test isolation only — the registry is otherwise a process-lifetime singleton, like `EquipmentRegistry`. */
export function resetForestRegistry(): void { domainToForest.clear(); }
