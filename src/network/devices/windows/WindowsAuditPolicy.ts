/**
 * WindowsAuditPolicy — `auditpol.exe` advanced audit policy state.
 *
 * Real Windows ships with most Object Access subcategories (Registry, File
 * System, …) OFF by default — enabling them (plus a SACL on the object,
 * simplified away here) is what makes 4657/4670 show up in the Security log
 * at all. Modeling that gate for real means a drift-detection script that
 * forgets to enable auditing genuinely sees nothing, matching production.
 */

export interface AuditSetting {
  success: boolean;
  failure: boolean;
}

const DEFAULT_SUBCATEGORIES: Record<string, AuditSetting> = {
  'registry':     { success: false, failure: false },
  'file system':  { success: false, failure: false },
  'logon':        { success: true,  failure: true },
  'logoff':       { success: true,  failure: false },
};

export class WindowsAuditPolicy {
  private subcategories = new Map<string, AuditSetting>(Object.entries(DEFAULT_SUBCATEGORIES));

  isEnabled(subcategory: string, kind: 'success' | 'failure'): boolean {
    return this.subcategories.get(subcategory.toLowerCase())?.[kind] ?? false;
  }

  set(subcategory: string, opts: { success?: boolean; failure?: boolean }): void {
    const key = subcategory.toLowerCase();
    const current = this.subcategories.get(key) ?? { success: false, failure: false };
    if (opts.success !== undefined) current.success = opts.success;
    if (opts.failure !== undefined) current.failure = opts.failure;
    this.subcategories.set(key, current);
  }

  get(subcategory: string): AuditSetting | undefined {
    return this.subcategories.get(subcategory.toLowerCase());
  }

  formatGet(subcategory: string): string {
    const s = this.get(subcategory);
    if (!s) return `The subcategory "${subcategory}" was not found.`;
    const setting = s.success && s.failure ? 'Success and Failure'
      : s.success ? 'Success' : s.failure ? 'Failure' : 'No Auditing';
    return [
      'System audit policy',
      'Category/Subcategory                     Setting',
      `  ${subcategory.padEnd(40)}${setting}`,
    ].join('\n');
  }
}

/** Parse `/flag:"value"` and `/flag` tokens (auditpol's own CLI syntax). */
function parseAuditpolArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of args) {
    const m = /^\/(\w+):?"?([^"]*)"?$/.exec(arg);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

export function cmdAuditpol(policy: WindowsAuditPolicy, args: string[]): string {
  if (args.length === 0) {
    return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
  }
  const sub = args[0].toLowerCase();
  const opts = parseAuditpolArgs(args.slice(1));

  if (sub === '/set') {
    const subcategory = opts['subcategory'];
    if (!subcategory) return 'The subcategory was not found.';
    const setOpts: { success?: boolean; failure?: boolean } = {};
    if (opts['success'] !== undefined) setOpts.success = opts['success'].toLowerCase() === 'enable';
    if (opts['failure'] !== undefined) setOpts.failure = opts['failure'].toLowerCase() === 'enable';
    policy.set(subcategory, setOpts);
    return 'The command was successfully executed.';
  }

  if (sub === '/get') {
    const subcategory = opts['subcategory'];
    if (!subcategory) return 'The category was not found.';
    return policy.formatGet(subcategory);
  }

  return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
}
