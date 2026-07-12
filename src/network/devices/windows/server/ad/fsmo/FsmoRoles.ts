/**
 * DomainFsmoRoles — the three domain-wide FSMO roles (RID Master, PDC
 * Emulator, Infrastructure Master), modeled as ordinary attributes on
 * the domain root entry — real AD's `fSMORoleOwner` simplified to a
 * plain DC hostname string instead of a full NTDS Settings DN. Role
 * ownership therefore replicates to other DCs of the same domain via
 * the existing entry-replication path with no extra plumbing: a DC
 * added via `Install-ADDSDomainController` picks it up in its initial
 * sync like any other domain-root attribute.
 *
 * Schema Master / Domain Naming Master are forest-wide, not domain-wide
 * — see `forest/Forest.ts` for those (same "shared by reference"
 * simplification already used there for the forest's `SchemaValidator`).
 */
import { DirectoryTree } from '../ldap/DirectoryTree';
import type { DistinguishedName } from '../ldap/LdapDN';

export type DomainFsmoRole = 'RidMaster' | 'PdcEmulator' | 'InfrastructureMaster';

export const DOMAIN_FSMO_ROLE_ATTR: Record<DomainFsmoRole, string> = {
  RidMaster: 'fsmoRidMaster',
  PdcEmulator: 'fsmoPdcEmulator',
  InfrastructureMaster: 'fsmoInfrastructureMaster',
};
const ATTR = DOMAIN_FSMO_ROLE_ATTR;

export const DOMAIN_FSMO_ROLES: readonly DomainFsmoRole[] = ['RidMaster', 'PdcEmulator', 'InfrastructureMaster'];

export class DomainFsmoRoles {
  constructor(private readonly tree: DirectoryTree, private readonly domainRootDn: DistinguishedName) {}

  getOwner(role: DomainFsmoRole): string | null {
    const entry = this.tree.getByDn(this.domainRootDn);
    return entry?.attributes.get(ATTR[role].toLowerCase())?.[0] ?? null;
  }

  /** First DC of a (forest-root or child) domain holds all three, matching real DCPromo defaults. */
  seedAllTo(hostname: string): void {
    this.tree.modifyEntry(this.domainRootDn, DOMAIN_FSMO_ROLES.map(role => ({
      op: 'replace' as const, type: ATTR[role], values: [hostname],
    })));
  }

  /** `Move-ADDirectoryServerOperationMasterRole -Force` (seize) — the calling DC unilaterally claims the role for itself. */
  seize(role: DomainFsmoRole, newOwnerHostname: string): void {
    this.tree.modifyEntry(this.domainRootDn, [{ op: 'replace', type: ATTR[role], values: [newOwnerHostname] }]);
  }
}
