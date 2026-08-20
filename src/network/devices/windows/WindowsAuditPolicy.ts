import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_NAMES,
  findSubcategory,
  findCategory,
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

export type AuditGlobalOptionName =
  | 'CrashOnAuditFail'
  | 'FullPrivilegeAuditing'
  | 'AuditBaseObjects'
  | 'AuditBaseDirectories';

const GLOBAL_OPTION_NAMES: readonly AuditGlobalOptionName[] = [
  'CrashOnAuditFail', 'FullPrivilegeAuditing', 'AuditBaseObjects', 'AuditBaseDirectories',
];

export interface PerUserAuditEntry {
  account: string;
  category: string;
  mode: 'include' | 'exclude';
  success?: boolean;
  failure?: boolean;
}

export type ResourceType = 'File' | 'Key' | 'Service' | 'Kernel';

export interface ResourceSaclEntry {
  type: ResourceType;
  success: boolean;
  failure: boolean;
  perUser?: Map<string, { success: boolean; failure: boolean }>;
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
  private options: Record<AuditGlobalOptionName, boolean> = {
    CrashOnAuditFail: false,
    FullPrivilegeAuditing: false,
    AuditBaseObjects: false,
    AuditBaseDirectories: false,
  };
  private perUser = new Map<string, PerUserAuditEntry[]>();
  private resourceSacl = new Map<ResourceType, ResourceSaclEntry>();
  private securityDescriptor: string | null = null;

  isEnabled(subcategory: string, kind: 'success' | 'failure', account?: string): boolean {
    if (account) {
      const entries = this.perUser.get(account.toLowerCase()) ?? [];
      const match = entries.find((e) => e.category.toLowerCase() === subcategory.toLowerCase());
      if (match) {
        const flag = kind === 'success' ? (match.success ?? true) : (match.failure ?? true);
        if (match.mode === 'exclude' && flag) return false;
        if (match.mode === 'include' && flag) return true;
      }
    }
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

  listSubcategoryNames(category?: string): string[] {
    if (category === undefined) return AUDIT_CATEGORIES.map((d) => d.name);
    const cat = findCategory(category);
    if (!cat) return [];
    return subcategoriesForCategory(cat).map((d) => d.name);
  }

  listCategoryNames(): string[] {
    return [...AUDIT_CATEGORY_NAMES];
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

  // ─── P10: global LSA options ────────────────────────────────────────

  getOption(name: string): boolean | undefined {
    const key = GLOBAL_OPTION_NAMES.find((n) => n.toLowerCase() === name.toLowerCase());
    return key ? this.options[key] : undefined;
  }

  setOption(name: string, value: boolean): boolean {
    const key = GLOBAL_OPTION_NAMES.find((n) => n.toLowerCase() === name.toLowerCase());
    if (!key) return false;
    this.options[key] = value;
    return true;
  }

  formatGetOption(name: string): string {
    const key = GLOBAL_OPTION_NAMES.find((n) => n.toLowerCase() === name.toLowerCase());
    if (!key) return 'The option was not found.';
    return [
      'System audit policy',
      'Option                                   Value',
      `${key.padEnd(41)}${this.options[key] ? 'Enabled' : 'Disabled'}`,
    ].join('\n');
  }

  // ─── P11: per-user audit policy ──────────────────────────────────────

  setPerUser(account: string, category: string, mode: 'include' | 'exclude', opts: { success?: boolean; failure?: boolean }): boolean {
    if (!findSubcategory(category) && !findCategory(category)) return false;
    const key = account.toLowerCase();
    const list = this.perUser.get(key) ?? [];
    const idx = list.findIndex((e) => e.category.toLowerCase() === category.toLowerCase());
    const entry: PerUserAuditEntry = { account, category, mode, success: opts.success, failure: opts.failure };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.perUser.set(key, list);
    return true;
  }

  removePerUser(account?: string): void {
    if (account) this.perUser.delete(account.toLowerCase());
    else this.perUser.clear();
  }

  listPerUserAccounts(): string[] {
    return [...this.perUser.keys()];
  }

  // ─── P12: resourceSACL (global object access auditing) ──────────────

  setResourceSacl(type: ResourceType, opts: { success?: boolean; failure?: boolean; account?: string }): void {
    let entry = this.resourceSacl.get(type);
    if (!entry) {
      entry = { type, success: false, failure: false };
      this.resourceSacl.set(type, entry);
    }
    if (opts.account) {
      if (!entry.perUser) entry.perUser = new Map();
      const cur = entry.perUser.get(opts.account.toLowerCase()) ?? { success: false, failure: false };
      if (opts.success !== undefined) cur.success = opts.success;
      if (opts.failure !== undefined) cur.failure = opts.failure;
      entry.perUser.set(opts.account.toLowerCase(), cur);
    } else {
      if (opts.success !== undefined) entry.success = opts.success;
      if (opts.failure !== undefined) entry.failure = opts.failure;
    }
  }

  removeResourceSacl(type: ResourceType, account?: string): boolean {
    const entry = this.resourceSacl.get(type);
    if (!entry) return false;
    if (account) { entry.perUser?.delete(account.toLowerCase()); return true; }
    this.resourceSacl.delete(type);
    return true;
  }

  clearResourceSacl(type: ResourceType): void {
    this.resourceSacl.delete(type);
  }

  isResourceAudited(type: ResourceType, kind: 'success' | 'failure', account?: string): boolean {
    const entry = this.resourceSacl.get(type);
    if (!entry) return false;
    if (account) {
      const u = entry.perUser?.get(account.toLowerCase());
      if (u) return u[kind];
    }
    return entry[kind];
  }

  viewResourceSacl(type?: ResourceType, account?: string): string {
    const types: ResourceType[] = type ? [type] : ['File', 'Key', 'Service', 'Kernel'];
    const lines: string[] = [];
    for (const t of types) {
      lines.push(`Resource SACLs for ${t}:`);
      const entry = this.resourceSacl.get(t);
      if (!entry) { lines.push('No entries found.'); continue; }
      if (account) {
        const u = entry.perUser?.get(account.toLowerCase());
        lines.push(u ? `  ${account}: ${settingLabel(u)}` : 'No entries found.');
      } else {
        lines.push(`  (global): ${settingLabel(entry)}`);
        for (const [acct, s] of entry.perUser ?? []) lines.push(`  ${acct}: ${settingLabel(s)}`);
      }
    }
    return lines.join('\n');
  }

  // ─── P13: security descriptor of the policy itself ───────────────────

  getSecurityDescriptorSddl(): string {
    return this.securityDescriptor ?? 'O:BAG:SYD:(A;;RCWDWO;;;BA)';
  }

  setSecurityDescriptor(sddl: string): void {
    this.securityDescriptor = sddl;
  }

  /**
   * Minimal SDDL evaluator (PRD-Auditpol.md §4.7): with no custom SD, the
   * policy has no read/write gate of its own — `/set`'s own `isAdmin`
   * check (P3) is the only requirement, and `/get` stays open, matching
   * real auditpol's default SD ("Administrators only" applies to write,
   * not read). Once a custom SD is posted, only callers whose ACE ("BA" —
   * Builtin Administrators) is explicitly allowed can read/modify the
   * policy, even if `isAdmin` is otherwise true.
   */
  canAccessPolicy(isAdmin: boolean): boolean {
    if (this.securityDescriptor === null) return true;
    if (!isAdmin) return false;
    return /\(A;[^;]*;[^;]*;;;BA\)/.test(this.securityDescriptor);
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
  '  /resourceSACL Configures global resource SACLs.',
].join('\n');

const NO_PRIVILEGE = 'Error 0x00000522: A required privilege is not held by the client.';
const ACCESS_DENIED_SD = 'Error 0x00000005: Access is denied.';

const RESOURCE_TYPES = ['File', 'Key', 'Service', 'Kernel'] as const;
function parseResourceType(v: string | undefined): 'File' | 'Key' | 'Service' | 'Kernel' | null {
  if (!v) return null;
  return RESOURCE_TYPES.find((t) => t.toLowerCase() === v.toLowerCase()) ?? null;
}

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
    if (!policy.canAccessPolicy(isAdmin)) return ACCESS_DENIED_SD;

    if (opts['sd'] !== undefined) {
      policy.setSecurityDescriptor(opts['sd']);
      return 'The command was successfully executed.';
    }

    if (opts['option'] !== undefined) {
      const value = opts['value'];
      if (value === undefined) return 'The value was not specified.';
      const applied = policy.setOption(opts['option'], value.toLowerCase() === 'enable');
      return applied ? 'The command was successfully executed.' : 'The option was not found.';
    }

    if (opts['user'] !== undefined) {
      const account = opts['user'];
      const category = opts['category'];
      if (!category) return 'The category was not specified.';
      const mode = opts['include'] !== undefined ? 'include' : opts['exclude'] !== undefined ? 'exclude' : null;
      if (!mode) return 'Either /include or /exclude must be specified.';
      const setOpts: { success?: boolean; failure?: boolean } = {};
      if (opts['success'] !== undefined) setOpts.success = opts['success'].toLowerCase() === 'enable';
      if (opts['failure'] !== undefined) setOpts.failure = opts['failure'].toLowerCase() === 'enable';
      const applied = policy.setPerUser(account, category, mode, setOpts);
      return applied ? 'The command was successfully executed.' : 'The category was not found.';
    }

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
    if (!policy.canAccessPolicy(isAdmin)) return ACCESS_DENIED_SD;
    if (opts['sd'] !== undefined) return policy.getSecurityDescriptorSddl();
    if (opts['r'] !== undefined) return policy.backup(machineName);
    if (opts['option'] !== undefined) return policy.formatGetOption(opts['option']);
    if (opts['category'] !== undefined) return policy.formatGetAll();
    const subcategory = opts['subcategory'];
    if (!subcategory) return 'The category was not found.';
    return policy.formatGet(subcategory);
  }

  if (sub === '/list') {
    if (opts['user'] !== undefined) {
      const accounts = policy.listPerUserAccounts();
      return accounts.length > 0 ? accounts.join('\n') : 'No per-user audit policy entries.';
    }
    if (opts['category'] !== undefined) {
      return policy.listCategoryNames().join('\n');
    }
    if (opts['subcategory'] !== undefined) {
      const val = opts['subcategory'];
      const names = val === '*' || val === '' ? policy.listSubcategoryNames() : policy.listSubcategoryNames(val);
      return names.join('\n');
    }
    return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
  }

  if (sub === '/backup') {
    if (!policy.canAccessPolicy(isAdmin)) return ACCESS_DENIED_SD;
    if (!io) return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
    const file = opts['file'];
    if (!file) return 'The backup file was not specified.';
    const absPath = io.resolvePath(file);
    const written = io.writeFile(absPath, policy.backup(machineName));
    return written ? 'The command was successfully executed.' : `Unable to write file "${file}".`;
  }

  if (sub === '/restore') {
    if (!isAdmin) return NO_PRIVILEGE;
    if (!policy.canAccessPolicy(isAdmin)) return ACCESS_DENIED_SD;
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
    if (!policy.canAccessPolicy(isAdmin)) return ACCESS_DENIED_SD;
    if (opts['y'] === undefined) {
      return 'This operation will clear the current audit policy and restore the default policy. Use /y to confirm.';
    }
    policy.clear();
    return 'The command was successfully executed.';
  }

  if (sub === '/remove') {
    if (!isAdmin) return NO_PRIVILEGE;
    if (opts['user'] !== undefined) {
      policy.removePerUser(opts['user']);
      return 'The command was successfully executed.';
    }
    if (opts['allusers'] !== undefined) {
      policy.removePerUser();
      return 'The command was successfully executed.';
    }
    return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
  }

  if (sub === '/resourcesacl') {
    const type = parseResourceType(opts['type']);
    if (opts['view'] !== undefined || (opts['set'] === undefined && opts['remove'] === undefined && opts['clear'] === undefined)) {
      return policy.viewResourceSacl(type ?? undefined, opts['user']);
    }
    if (opts['set'] !== undefined) {
      if (!isAdmin) return NO_PRIVILEGE;
      if (!type) return 'The resource type was not found.';
      const setOpts: { success?: boolean; failure?: boolean; account?: string } = {};
      if (opts['success'] !== undefined) setOpts.success = true;
      if (opts['failure'] !== undefined) setOpts.failure = true;
      if (opts['user'] !== undefined) setOpts.account = opts['user'];
      policy.setResourceSacl(type, setOpts);
      return 'The command was successfully executed.';
    }
    if (opts['remove'] !== undefined) {
      if (!isAdmin) return NO_PRIVILEGE;
      if (!type) return 'The resource type was not found.';
      const removed = policy.removeResourceSacl(type, opts['user']);
      return removed ? 'The command was successfully executed.' : 'The resource type was not found.';
    }
    if (opts['clear'] !== undefined) {
      if (!isAdmin) return NO_PRIVILEGE;
      if (!type) return 'The resource type was not found.';
      policy.clearResourceSacl(type);
      return 'The command was successfully executed.';
    }
    return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
  }

  return 'AuditPol.exe command not recognized. Use AuditPol /? for usage.';
}
