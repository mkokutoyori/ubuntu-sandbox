import type { WindowsPC } from '@/network/devices/WindowsPC';
import type { AuditPolicyState } from '@/network/devices/windows/WindowsAuditPolicy';
import type { WindowsAccountsPolicyState } from '@/network/devices/windows/security/WindowsAccountsPolicy';

export interface WindowsSecurityPolicyState {
  accounts?: Partial<WindowsAccountsPolicyState>;
  audit?: Partial<AuditPolicyState>;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function accountsDelta(device: WindowsPC, twin: WindowsPC): Partial<WindowsAccountsPolicyState> | undefined {
  const live = device.accountsPolicy.snapshot();
  const factory = twin.accountsPolicy.snapshot();
  const changed = (Object.keys(live) as Array<keyof WindowsAccountsPolicyState>).filter((key) => live[key] !== factory[key]);
  if (changed.length === 0) return undefined;
  return Object.fromEntries(changed.map((key) => [key, live[key]])) as Partial<WindowsAccountsPolicyState>;
}

function auditDelta(device: WindowsPC, twin: WindowsPC): Partial<AuditPolicyState> | undefined {
  const live = device.auditPolicy.exportState();
  const factory = twin.auditPolicy.exportState();
  const factorySubcategories = new Map(factory.subcategories.map((s) => [s.name, s]));
  const subcategories = live.subcategories.filter((s) => !same(s, factorySubcategories.get(s.name)));
  const options = Object.fromEntries(Object.entries(live.options).filter(([name, value]) => factory.options[name as keyof typeof factory.options] !== value));
  const delta: Partial<AuditPolicyState> = {
    ...(subcategories.length > 0 ? { subcategories } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(same(live.perUser, factory.perUser) ? {} : { perUser: live.perUser }),
    ...(same(live.resourceSacl, factory.resourceSacl) ? {} : { resourceSacl: live.resourceSacl }),
    ...(live.securityDescriptor === factory.securityDescriptor ? {} : { securityDescriptor: live.securityDescriptor }),
  };
  return Object.keys(delta).length > 0 ? delta : undefined;
}

export function captureWindowsSecurityPolicy(device: WindowsPC, twin: WindowsPC): WindowsSecurityPolicyState | undefined {
  const accounts = accountsDelta(device, twin);
  const audit = auditDelta(device, twin);
  if (!accounts && !audit) return undefined;
  return { ...(accounts ? { accounts } : {}), ...(audit ? { audit } : {}) };
}

export function restoreWindowsSecurityPolicy(device: WindowsPC, state: WindowsSecurityPolicyState): void {
  if (state.accounts) device.accountsPolicy.restore(state.accounts);
  if (state.audit) device.auditPolicy.importState(state.audit);
}
