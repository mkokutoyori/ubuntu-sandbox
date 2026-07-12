import type { TcpStack } from '@/network/tcp/TcpStack';
import type { DirectoryStore } from './DirectoryStore';
import type { Forest, ForestFsmoRole } from './forest/Forest';
import { DOMAIN_FSMO_ROLES, type DomainFsmoRole } from './fsmo/FsmoRoles';
import { transferDomainFsmoRole } from '../../domain/FsmoTransferClient';
import { UgmcCache } from './gc/UgmcCache';
import { refreshUgmcFromGc } from '../../domain/UgmcRefreshClient';

export type FsmoRole = DomainFsmoRole | ForestFsmoRole;
export interface FsmoOpResult { ok: boolean; message: string }

function isDomainFsmoRole(role: FsmoRole): role is DomainFsmoRole {
  return (DOMAIN_FSMO_ROLES as readonly string[]).includes(role);
}

export interface DcOpsHost {
  getDirectoryStore(): DirectoryStore | null;
  getForest(): Forest | null;
  getHostname(): string;
  getTcpStack(): TcpStack;
  isGlobalCatalogServer(): boolean;
}

/**
 * Domain-controller-level operations that don't belong to a single AD
 * subsystem on their own (FSMO role queries/transfer, AdminSDHolder/SDProp,
 * Universal Group Membership Caching) — extracted out of `WindowsServer`
 * so that file stops growing every time a new DC-level feature lands here.
 */
export class DomainControllerOps {
  private readonly ugmcCache = new UgmcCache();

  constructor(private readonly host: DcOpsHost) {}

  /** `(Get-ADDomain).RIDMaster`/`PDCEmulator`/`InfrastructureMaster` or `(Get-ADForest).SchemaMaster`/`DomainNamingMaster` — the current holder's hostname, or null if this server isn't a DC (or, for the forest-wide roles, isn't part of a forest). */
  getFsmoRoleOwner(role: FsmoRole): string | null {
    if (isDomainFsmoRole(role)) return this.host.getDirectoryStore()?.getFsmoRoleOwner(role) ?? null;
    return this.host.getForest()?.getFsmoRoleOwner(role) ?? null;
  }

  /** `Move-ADDirectoryServerOperationMasterRole -Force` — this DC unilaterally claims the role for itself, without contacting the current holder (disaster-recovery semantics; real AD's own seize doesn't contact it either). */
  seizeFsmoRole(role: FsmoRole): FsmoOpResult {
    const store = this.host.getDirectoryStore();
    if (!store) return { ok: false, message: 'This computer is not a domain controller.' };
    if (isDomainFsmoRole(role)) {
      store.seizeFsmoRole(role, this.host.getHostname());
      return { ok: true, message: '' };
    }
    const forest = this.host.getForest();
    if (!forest) return { ok: false, message: 'This computer is not part of a forest.' };
    forest.seizeFsmoRole(role, this.host.getHostname());
    return { ok: true, message: '' };
  }

  /**
   * `Move-ADDirectoryServerOperationMasterRole` (graceful transfer) —
   * domain-wide roles only, see `FsmoTransferClient`'s header for why
   * Schema Master/Domain Naming Master use `seizeFsmoRole` instead.
   * Records the same change locally once the remote write succeeds, so
   * the result is immediately observable — matching what ordinary
   * multi-master replication would converge to regardless.
   */
  transferFsmoRoleTo(role: DomainFsmoRole, currentHolderDcAddress: string, credentialUser: string, credentialPassword: string): FsmoOpResult {
    const store = this.host.getDirectoryStore();
    if (!store) return { ok: false, message: 'This computer is not a domain controller.' };
    const result = transferDomainFsmoRole({
      tcpStack: this.host.getTcpStack(), role, currentHolderDcAddress,
      domainRootDn: store.getDomainDn(), credentialUser, credentialPassword,
      newOwnerHostname: this.host.getHostname(),
    });
    if (result.ok) store.seizeFsmoRole(role, this.host.getHostname());
    return result;
  }

  /**
   * One AdminSDHolder/SDProp pass — real AD only ever runs this on the
   * PDC Emulator (every 60 minutes there); this simulator triggers it
   * manually, matching the existing convention for other periodic AD
   * processes (`ReplicationSession.ts`'s own header comment).
   */
  runSdProp(): FsmoOpResult & { protectedMembers?: string[] } {
    const store = this.host.getDirectoryStore();
    if (!store) return { ok: false, message: 'This computer is not a domain controller.' };
    if (store.getFsmoRoleOwner('PdcEmulator') !== this.host.getHostname()) {
      return { ok: false, message: 'This computer does not hold the PDC Emulator role.' };
    }
    return { ok: true, message: '', protectedMembers: store.runSdProp() };
  }

  isUgmcEnabled(): boolean { return this.ugmcCache.isEnabled(); }

  /** A Global Catalog already has every universal group's full membership locally — enabling UGMC on one would be pointless, matching real AD's own guidance. */
  enableUgmc(): FsmoOpResult {
    if (!this.host.getDirectoryStore()) return { ok: false, message: 'This computer is not a domain controller.' };
    if (this.host.isGlobalCatalogServer()) return { ok: false, message: 'This server is a Global Catalog; Universal Group Membership Caching is not applicable.' };
    this.ugmcCache.enable();
    return { ok: true, message: '' };
  }

  disableUgmc(): void { this.ugmcCache.disable(); }

  /**
   * Refreshes this DC's cache from a real Global Catalog over the wire
   * (real AD: every 8 hours, on whichever site the DC belongs to; here,
   * manually triggered — same convention as replication/SDProp).
   */
  refreshUgmc(gcAddress: string, credentialUser: string, credentialPassword: string): FsmoOpResult {
    const store = this.host.getDirectoryStore();
    if (!store) return { ok: false, message: 'This computer is not a domain controller.' };
    if (!this.ugmcCache.isEnabled()) return { ok: false, message: 'Universal Group Membership Caching is not enabled on this server.' };
    const result = refreshUgmcFromGc(this.host.getTcpStack(), gcAddress, store.getDomainDn(), credentialUser, credentialPassword);
    if (!result.ok || !result.membership) return { ok: false, message: result.message };
    this.ugmcCache.installSnapshot(result.membership);
    return { ok: true, message: '' };
  }

  /** Cached universal-group SAMs for `userSam`, or `null` if UGMC isn't enabled/cache not yet populated (caller should fall back to a direct GC query). */
  getCachedUniversalGroupsFor(userSam: string): string[] | null {
    return this.ugmcCache.getCachedUniversalGroupsFor(userSam);
  }
}
