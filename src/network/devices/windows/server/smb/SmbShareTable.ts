/**
 * SmbShareTable — per-device share table backing both `net share` (cmd)
 * and `New/Get/Remove-SmbShare` (PowerShell), and consulted by
 * `SmbServerHandler` for tree-connect/read/write permission checks.
 *
 * Instance-owned (constructed once per device, e.g. `WindowsPC.smbShares`)
 * rather than the module-level `Map` `WinNetShare.ts` used to key by
 * hostname — PRD-Windows-Server.md §7 risk 6 flags that pattern as
 * leaking state across devices that share a hostname and across tests.
 */

import type { SharePermission, SmbShare, SmbShareView } from './SmbTypes';

export class SmbShareTable {
  private readonly shares = new Map<string, SmbShare>();

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults(): void {
    this.shares.set('admin$', {
      name: 'ADMIN$', path: 'C:\\Windows', description: 'Remote Admin', special: true,
      permissions: new Map([['Administrators', 'Full']]),
    });
    this.shares.set('c$', {
      name: 'C$', path: 'C:\\', description: 'Default share', special: true,
      permissions: new Map([['Administrators', 'Full']]),
    });
    this.shares.set('ipc$', {
      name: 'IPC$', path: '', description: 'Remote IPC', special: true,
      permissions: new Map(),
    });
  }

  list(): SmbShare[] {
    return [...this.shares.values()];
  }

  get(name: string): SmbShare | undefined {
    return this.shares.get(name.toLowerCase());
  }

  /** Effective share permission for `principal` — exact match, else `Everyone`, else none. */
  permissionFor(share: SmbShare, principal: string, groups: readonly string[]): SharePermission | null {
    const byUser = share.permissions.get(principal);
    if (byUser) return byUser;
    for (const g of groups) {
      const byGroup = share.permissions.get(g);
      if (byGroup) return byGroup;
    }
    return share.permissions.get('Everyone') ?? null;
  }

  add(
    name: string,
    path: string,
    opts: { description?: string; permissions?: Map<string, SharePermission> } = {},
  ): { ok: boolean; message: string } {
    if (this.shares.has(name.toLowerCase())) {
      return { ok: false, message: `The specified share name already exists.` };
    }
    this.shares.set(name.toLowerCase(), {
      name, path, description: opts.description ?? '', special: false,
      permissions: opts.permissions ?? new Map([['Everyone', 'Read']]),
    });
    return { ok: true, message: '' };
  }

  remove(name: string): { ok: boolean; message: string } {
    const key = name.toLowerCase();
    const share = this.shares.get(key);
    if (!share) return { ok: false, message: 'This shared resource does not exist.' };
    if (share.special) return { ok: false, message: 'The specified share name cannot be deleted.' };
    this.shares.delete(key);
    return { ok: true, message: '' };
  }

  toView(share: SmbShare): SmbShareView {
    return {
      name: share.name, path: share.path, description: share.description, special: share.special,
      permissions: [...share.permissions.entries()].map(([principal, access]) => ({ principal, access })),
    };
  }
}
