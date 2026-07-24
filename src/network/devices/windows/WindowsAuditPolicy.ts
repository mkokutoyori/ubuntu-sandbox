import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_NAMES,
  findSubcategory,
  subcategoriesForCategory,
} from './WindowsAuditCategoryCatalog';

export interface AuditSetting {
  success: boolean;
  failure: boolean;
}

interface AuditEntry extends AuditSetting {
  displayName: string;
}

export type AuditBaselineProfile = 'client' | 'server' | 'domain-controller';

export interface AuditPolFileIO {
  resolvePath(path: string): string;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): boolean;
}

const CLIENT_SERVER_BASELINE: ReadonlyArray<readonly [string, AuditSetting]> = [
  ['Logon', { success: true, failure: true }],
  ['Logoff', { success: true, failure: false }],
  ['Account Lockout', { success: true, failure: false }],
  ['Special Logon', { success: true, failure: false }],
  ['Process Creation', { success: true, failure: false }],
  ['Process Termination', { success: true, failure: false }],
  ['User Account Management', { success: true, failure: false }],
  ['Security Group Management', { success: true, failure: false }],
];

const DOMAIN_CONTROLLER_BASELINE: ReadonlyArray<readonly [string, AuditSetting]> = [
  ['Directory Service Access', { success: true, failure: false }],
  ['Directory Service Changes', { success: true, failure: false }],
  ['Kerberos Authentication Service', { success: true, failure: false }],
  ['Credential Validation', { success: true, failure: false }],
];

function settingLabel(s: AuditSetting): string {
  return s.success && s.failure ? 'Success and Failure'
    : s.success ? 'Success' : s.failure ? 'Failure' : 'No Auditing';
}

function settingValue(s: AuditSetting): number {
  return s.success && s.failure ? 3 : s.failure ? 2 : s.success ? 1 : 0;
}

export class WindowsAuditPolicy {
  private subcategories = new Map<string, AuditEntry>(
    AUDIT_CATEGORIES.map((def) => [def.name.toLowerCase(), { success: false, failure: false, displayName: def.name }]),
  );
  private baselineProfile: AuditBaselineProfile = 'client';

  isEnabled(subcategory: string, kind: 'success' | 'failure', account?: string): boolean {
    void account;
    return this.subcategories.get(subcategory.toLowerCase())?.[kind] ?? false;
  }

  set(subcategory: string, opts: { success?: boolean; failure?: boolean }): boolean {
    const key = subcategory.toLowerCase();
    const entry = this.subcategories.get(key);
    if (!entry) return false;
    if (opts.success !== undefined) entry.success = opts.success;
    if (opts.failure !== undefined) entry.failure = opts.failure;
    return true;
  }

  get(subcategory: string): AuditSetting | undefined {
    return this.subcategories.get(subcategory.toLowerCase());
  }

  listAll(): AuditEntry[] {
    return [...this.subcategories.values()];
  }

  listSubcategoryNames(): string[] {
    return AUDIT_CATEGORIES.map((d) => d.name);
  }

  seedDefaults(profile: AuditBaselineProfile): void {
    this.baselineProfile = profile;
    for (const entry of this.subcategories.values()) {
      entry.success = false;
      entry.failure = false;
    }
    for (const [name, setting] of CLIENT_SERVER_BASELINE) this.set(name, setting);
    if (profile === 'domain-controller') {
      for (const [name, setting] of DOMAIN_CONTROLLER_BASELINE) this.set(name, setting);
    }
  }

  clear(): void {
    this.seedDefaults(this.baselineProfile);
  }

  formatGet(subcategory: string): string {
    const s = this.get(subcategory);
    if (!s) return 'The category was not found.';
    return [
      'System audit policy',
      'Category/Subcategory                     Setting',
      `  ${subcategory.padEnd(40)}${settingLabel(s)}`,
    ].join('\n');
  }

  formatGetAll(): string {
    const lines = ['System audit policy', 'Category/Subcategory                     Setting'];
    for (const category of AUDIT_CATEGORY_NAMES) {
      lines.push(category);
      for (const def of subcategoriesForCategory(category)) {
        const s = this.subcategories.get(def.name.toLowerCase())!;
        lines.push(`  ${def.name.padEnd(40)}${settingLabel(s)}`);
      }
    }
    return lines.join('\n');
  }

  backup(machineName: string): string {
    const lines = ['Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting,Setting Value'];
    for (const def of AUDIT_CATEGORIES) {
      const s = this.subcategories.get(def.name.toLowerCase())!;
      lines.push(`${machineName},System,${def.name},${def.guid},${settingLabel(s)},,${settingValue(s)}`);
    }
    return lines.join('\r\n') + '\r\n';
  }

  restore(csv: string): boolean {
    const rows = csv.trim().split(/\r?\n/).slice(1).filter((r) => r.length > 0);
    const parsed: Array<{ name: string; value: number }> = [];
    for (const row of rows) {
      const cols = row.split(',');
      if (cols.length < 7) return false;
      const name = cols[2];
      const value = Number(cols[6]);
      if (!findSubcategory(name) || Number.isNaN(value)) return false;
      parsed.push({ name, value });
    }
    for (const { name, value } of parsed) {
      this.set(name, { success: value === 1 || value === 3, failure: value === 2 || value === 3 });
    }
    return true;
  }
}

function parseAuditpolArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of args) {
    const m = /^\/(\w+):?"?([^"]*)"?$/.exec(arg);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

const AUDITPOL_HELP = [
  'AuditPol command line tool',
  '  /get       Displays the current audit policy.',
  '  /set       Sets the audit policy.',
  '  /list      Displays selectable policy elements.',
  '  /backup    Saves the audit policy to a file.',
  '  /restore   Restores the audit policy from a file.',
  '  /clear     Clears the audit policy and restores the default baseline.',
].join('\n');

const NO_PRIVILEGE = 'Error 0x00000522: A required privilege is not held by the client.';

export function cmdAuditpol(
  policy: WindowsAuditPolicy,
  args: string[],
  isAdmin = true,
  io?: AuditPolFileIO,
  machineName = 'WIN-PC',
): string {
  if (args.length === 0) {
    return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
  }
  const sub = args[0].toLowerCase();
  const opts = parseAuditpolArgs(args.slice(1));

  if (sub === '/?' || sub === '/help') {
    return AUDITPOL_HELP;
  }

  if (sub === '/set') {
    if (!isAdmin) return NO_PRIVILEGE;
    const subcategory = opts['subcategory'];
    if (!subcategory) return 'The subcategory was not found.';
    const setOpts: { success?: boolean; failure?: boolean } = {};
    if (opts['success'] !== undefined) setOpts.success = opts['success'].toLowerCase() === 'enable';
    if (opts['failure'] !== undefined) setOpts.failure = opts['failure'].toLowerCase() === 'enable';
    const applied = policy.set(subcategory, setOpts);
    if (!applied) return 'The category was not found.';
    return 'The command was successfully executed.';
  }

  if (sub === '/get') {
    if (opts['category'] !== undefined) return policy.formatGetAll();
    const subcategory = opts['subcategory'];
    if (!subcategory) return 'The category was not found.';
    return policy.formatGet(subcategory);
  }

  if (sub === '/list') {
    if (opts['subcategory'] !== undefined) {
      return policy.listSubcategoryNames().join('\n');
    }
    return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
  }

  if (sub === '/backup') {
    if (!io) return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
    const file = opts['file'];
    if (!file) return 'The backup file was not specified.';
    const absPath = io.resolvePath(file);
    const written = io.writeFile(absPath, policy.backup(machineName));
    return written ? 'The command was successfully executed.' : `Unable to write file "${file}".`;
  }

  if (sub === '/restore') {
    if (!isAdmin) return NO_PRIVILEGE;
    if (!io) return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
    const file = opts['file'];
    if (!file) return 'The restore file was not specified.';
    const absPath = io.resolvePath(file);
    const content = io.readFile(absPath);
    if (content === null) return `Unable to read file "${file}".`;
    const ok = policy.restore(content);
    return ok ? 'The command was successfully executed.' : `The file "${file}" is not a valid audit policy file.`;
  }

  if (sub === '/clear') {
    if (!isAdmin) return NO_PRIVILEGE;
    if (opts['y'] === undefined) {
      return 'This operation will clear the current audit policy and restore the default policy. Use /y to confirm.';
    }
    policy.clear();
    return 'The command was successfully executed.';
  }

  return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
}
