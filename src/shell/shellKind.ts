/**
 * Primary shell kind of a device, derived from its polymorphic
 * `Equipment.getOSType()` hook.
 *
 * Five call sites used to dispatch on `dev.constructor.name` strings
 * ('WindowsPC', 'CiscoRouter', …) — a minification hazard (the reason
 * vite.config.ts needs `keepNames: true`) and a maintenance trap: adding a
 * vendor meant updating every dispatcher. `getOSType()` is already
 * overridden by every device class, so the class-name sniffing was
 * redundant; this helper is now the single mapping.
 */
export type PrimaryShellKind = 'bash' | 'cmd' | 'cisco-ios' | 'huawei-vrp';

export function primaryShellKindFor(dev: { getOSType?: () => string }): PrimaryShellKind {
  switch (dev.getOSType?.()) {
    case 'windows': return 'cmd';
    case 'cisco-ios': return 'cisco-ios';
    case 'huawei-vrp': return 'huawei-vrp';
    // 'linux', 'generic' and anything unknown get a POSIX shell.
    default: return 'bash';
  }
}
