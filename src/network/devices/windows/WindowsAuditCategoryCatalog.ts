export type AuditCategoryName =
  | 'System'
  | 'Logon/Logoff'
  | 'Object Access'
  | 'Privilege Use'
  | 'Detailed Tracking'
  | 'Policy Change'
  | 'Account Management'
  | 'DS Access'
  | 'Account Logon';

export interface AuditSubcategoryDef {
  name: string;
  guid: string;
  category: AuditCategoryName;
  governs: number[];
}

export const AUDIT_CATEGORY_NAMES: readonly AuditCategoryName[] = [
  'System',
  'Logon/Logoff',
  'Object Access',
  'Privilege Use',
  'Detailed Tracking',
  'Policy Change',
  'Account Management',
  'DS Access',
  'Account Logon',
];

export const AUDIT_CATEGORIES: readonly AuditSubcategoryDef[] = [
  { name: 'Security State Change', guid: '{0CCE9210-69AE-11D9-BED3-505054503030}', category: 'System', governs: [] },
  { name: 'Security System Extension', guid: '{0CCE9211-69AE-11D9-BED3-505054503030}', category: 'System', governs: [] },
  { name: 'System Integrity', guid: '{0CCE9212-69AE-11D9-BED3-505054503030}', category: 'System', governs: [] },
  { name: 'IPsec Driver', guid: '{0CCE9213-69AE-11D9-BED3-505054503030}', category: 'System', governs: [] },
  { name: 'Other System Events', guid: '{0CCE9214-69AE-11D9-BED3-505054503030}', category: 'System', governs: [] },

  { name: 'Logon', guid: '{0CCE9215-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [4624, 4625] },
  { name: 'Logoff', guid: '{0CCE9216-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [4634, 4647] },
  { name: 'Account Lockout', guid: '{0CCE9217-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [4740, 4767] },
  { name: 'IPsec Main Mode', guid: '{0CCE9218-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [] },
  { name: 'IPsec Quick Mode', guid: '{0CCE9219-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [] },
  { name: 'IPsec Extended Mode', guid: '{0CCE921A-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [] },
  { name: 'Special Logon', guid: '{0CCE921B-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [4672, 4964] },
  { name: 'Other Logon/Logoff Events', guid: '{0CCE921C-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [4649, 4778, 4779, 4800, 4801, 4802, 4803] },
  { name: 'Network Policy Server', guid: '{0CCE9243-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [] },
  { name: 'User / Device Claims', guid: '{0CCE9247-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [] },
  { name: 'Group Membership', guid: '{0CCE9249-69AE-11D9-BED3-505054503030}', category: 'Logon/Logoff', governs: [] },

  { name: 'File System', guid: '{0CCE921D-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [4656, 4663, 4664] },
  { name: 'Registry', guid: '{0CCE921E-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [4657, 4663] },
  { name: 'Kernel Object', guid: '{0CCE921F-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },
  { name: 'SAM', guid: '{0CCE9220-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },
  { name: 'Certification Services', guid: '{0CCE9221-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },
  { name: 'Application Generated', guid: '{0CCE9222-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },
  { name: 'Handle Manipulation', guid: '{0CCE9223-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },
  { name: 'File Share', guid: '{0CCE9224-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [5140, 5142, 5143, 5144, 5168] },
  { name: 'Filtering Platform Packet Drop', guid: '{0CCE9225-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [5152, 5157] },
  { name: 'Filtering Platform Connection', guid: '{0CCE9226-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [5156, 5158, 5159] },
  { name: 'Other Object Access Events', guid: '{0CCE9227-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },
  { name: 'Detailed File Share', guid: '{0CCE9244-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [5145] },
  { name: 'Removable Storage', guid: '{0CCE9245-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },
  { name: 'Central Policy Staging', guid: '{0CCE9246-69AE-11D9-BED3-505054503030}', category: 'Object Access', governs: [] },

  { name: 'Sensitive Privilege Use', guid: '{0CCE9228-69AE-11D9-BED3-505054503030}', category: 'Privilege Use', governs: [4672, 4673, 4674] },
  { name: 'Non Sensitive Privilege Use', guid: '{0CCE9229-69AE-11D9-BED3-505054503030}', category: 'Privilege Use', governs: [4673, 4674] },
  { name: 'Other Privilege Use Events', guid: '{0CCE922A-69AE-11D9-BED3-505054503030}', category: 'Privilege Use', governs: [] },

  { name: 'Process Creation', guid: '{0CCE922B-69AE-11D9-BED3-505054503030}', category: 'Detailed Tracking', governs: [4688] },
  { name: 'Process Termination', guid: '{0CCE922C-69AE-11D9-BED3-505054503030}', category: 'Detailed Tracking', governs: [4689] },
  { name: 'DPAPI Activity', guid: '{0CCE922D-69AE-11D9-BED3-505054503030}', category: 'Detailed Tracking', governs: [] },
  { name: 'RPC Events', guid: '{0CCE922E-69AE-11D9-BED3-505054503030}', category: 'Detailed Tracking', governs: [] },
  { name: 'Plug and Play Events', guid: '{0CCE9248-69AE-11D9-BED3-505054503030}', category: 'Detailed Tracking', governs: [] },

  { name: 'Audit Policy Change', guid: '{0CCE922F-69AE-11D9-BED3-505054503030}', category: 'Policy Change', governs: [] },
  { name: 'Authentication Policy Change', guid: '{0CCE9230-69AE-11D9-BED3-505054503030}', category: 'Policy Change', governs: [] },
  { name: 'Authorization Policy Change', guid: '{0CCE9231-69AE-11D9-BED3-505054503030}', category: 'Policy Change', governs: [] },
  { name: 'MPSSVC Rule-Level Policy Change', guid: '{0CCE9232-69AE-11D9-BED3-505054503030}', category: 'Policy Change', governs: [] },
  { name: 'Filtering Platform Policy Change', guid: '{0CCE9233-69AE-11D9-BED3-505054503030}', category: 'Policy Change', governs: [] },
  { name: 'Other Policy Change Events', guid: '{0CCE9234-69AE-11D9-BED3-505054503030}', category: 'Policy Change', governs: [] },

  { name: 'User Account Management', guid: '{0CCE9235-69AE-11D9-BED3-505054503030}', category: 'Account Management', governs: [4720, 4722, 4724, 4725, 4726, 4738, 4740] },
  { name: 'Computer Account Management', guid: '{0CCE9236-69AE-11D9-BED3-505054503030}', category: 'Account Management', governs: [4741, 4742, 4743] },
  { name: 'Security Group Management', guid: '{0CCE9237-69AE-11D9-BED3-505054503030}', category: 'Account Management', governs: [4727, 4728, 4729, 4730, 4731, 4732, 4733, 4734, 4735, 4737, 4754, 4755, 4756, 4757, 4764] },
  { name: 'Distribution Group Management', guid: '{0CCE9238-69AE-11D9-BED3-505054503030}', category: 'Account Management', governs: [] },
  { name: 'Application Group Management', guid: '{0CCE9239-69AE-11D9-BED3-505054503030}', category: 'Account Management', governs: [] },
  { name: 'Other Account Management Events', guid: '{0CCE923A-69AE-11D9-BED3-505054503030}', category: 'Account Management', governs: [] },

  { name: 'Directory Service Access', guid: '{0CCE923B-69AE-11D9-BED3-505054503030}', category: 'DS Access', governs: [4661, 4662] },
  { name: 'Directory Service Changes', guid: '{0CCE923C-69AE-11D9-BED3-505054503030}', category: 'DS Access', governs: [5136, 5137, 5138, 5139, 5141] },
  { name: 'Directory Service Replication', guid: '{0CCE923D-69AE-11D9-BED3-505054503030}', category: 'DS Access', governs: [] },
  { name: 'Detailed Directory Service Replication', guid: '{0CCE923E-69AE-11D9-BED3-505054503030}', category: 'DS Access', governs: [] },

  { name: 'Credential Validation', guid: '{0CCE923F-69AE-11D9-BED3-505054503030}', category: 'Account Logon', governs: [4774, 4775, 4776, 4777] },
  { name: 'Kerberos Service Ticket Operations', guid: '{0CCE9240-69AE-11D9-BED3-505054503030}', category: 'Account Logon', governs: [4769, 4770, 4773] },
  { name: 'Other Account Logon Events', guid: '{0CCE9241-69AE-11D9-BED3-505054503030}', category: 'Account Logon', governs: [] },
  { name: 'Kerberos Authentication Service', guid: '{0CCE9242-69AE-11D9-BED3-505054503030}', category: 'Account Logon', governs: [4768, 4771, 4772] },
];

export function findSubcategory(name: string): AuditSubcategoryDef | undefined {
  const key = name.trim().toLowerCase();
  return AUDIT_CATEGORIES.find((s) => s.name.toLowerCase() === key);
}

export function subcategoriesForCategory(category: AuditCategoryName): AuditSubcategoryDef[] {
  return AUDIT_CATEGORIES.filter((s) => s.category === category);
}

export function findCategory(name: string): AuditCategoryName | undefined {
  const key = name.trim().toLowerCase();
  return AUDIT_CATEGORY_NAMES.find((c) => c.toLowerCase() === key);
}
