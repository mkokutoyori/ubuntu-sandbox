import type { PSProviders } from '@/powershell/providers/PSProviders';

export type ExecutionPolicy =
  | 'AllSigned' | 'Bypass' | 'Default' | 'RemoteSigned'
  | 'Restricted' | 'Undefined' | 'Unrestricted';

export type ExecutionPolicyScope =
  | 'MachinePolicy' | 'UserPolicy' | 'Process' | 'CurrentUser' | 'LocalMachine';

export const EXECUTION_POLICIES: readonly ExecutionPolicy[] = [
  'AllSigned', 'Bypass', 'Default', 'RemoteSigned',
  'Restricted', 'Undefined', 'Unrestricted',
];

export const EXECUTION_POLICY_SCOPES: readonly ExecutionPolicyScope[] = [
  'MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine',
];

export const SETTABLE_SCOPES: readonly ExecutionPolicyScope[] = [
  'Process', 'CurrentUser', 'LocalMachine',
];

export const PROCESS_POLICY_VARIABLE = 'PSExecutionPolicyPreference';

const SHELL_ID_SUBKEY = 'SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell';
const POLICY_SUBKEY = 'SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell';
const CURRENT_VERSION_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

const SCOPE_KEY: Record<ExecutionPolicyScope, string | null> = {
  MachinePolicy: `HKLM:\\${POLICY_SUBKEY}`,
  UserPolicy: `HKCU:\\${POLICY_SUBKEY}`,
  Process: null,
  CurrentUser: `HKCU:\\${SHELL_ID_SUBKEY}`,
  LocalMachine: `HKLM:\\${SHELL_ID_SUBKEY}`,
};

export function matchExecutionPolicy(raw: string): ExecutionPolicy | null {
  const lower = raw.trim().toLowerCase();
  return EXECUTION_POLICIES.find(p => p.toLowerCase() === lower) ?? null;
}

export function matchExecutionPolicyScope(raw: string): ExecutionPolicyScope | null {
  const lower = raw.trim().toLowerCase();
  return EXECUTION_POLICY_SCOPES.find(s => s.toLowerCase() === lower) ?? null;
}

export function platformDefaultPolicy(providers: PSProviders): ExecutionPolicy {
  if (!providers.registry) return 'Unrestricted';
  const values = providers.registry.getItemPropertyValues?.(CURRENT_VERSION_KEY) ?? {};
  const installationType = String(values['InstallationType'] ?? 'Client');
  return installationType.toLowerCase() === 'server' ? 'RemoteSigned' : 'Restricted';
}

export interface ProcessPolicyPort {
  read(): string | null;
  write(value: string | null): void;
}

export function storedPolicy(
  providers: PSProviders, scope: ExecutionPolicyScope, process: ProcessPolicyPort,
): ExecutionPolicy {
  if (scope === 'Process') {
    const raw = process.read();
    return raw === null || raw === '' ? 'Undefined' : matchExecutionPolicy(raw) ?? 'Undefined';
  }
  const key = SCOPE_KEY[scope];
  if (key === null) return 'Undefined';
  const values = providers.registry?.getItemPropertyValues?.(key) ?? {};
  const raw = values['ExecutionPolicy'];
  return raw === undefined ? 'Undefined' : matchExecutionPolicy(String(raw)) ?? 'Undefined';
}

export interface EffectivePolicy {
  policy: ExecutionPolicy;
  scope: ExecutionPolicyScope | null;
}

export function effectiveExecutionPolicy(
  providers: PSProviders, process: ProcessPolicyPort,
): EffectivePolicy {
  for (const scope of EXECUTION_POLICY_SCOPES) {
    const stored = storedPolicy(providers, scope, process);
    if (stored === 'Undefined') continue;
    if (stored === 'Default') return { policy: platformDefaultPolicy(providers), scope };
    return { policy: stored, scope };
  }
  return { policy: platformDefaultPolicy(providers), scope: null };
}

export function writeExecutionPolicy(
  providers: PSProviders, scope: ExecutionPolicyScope,
  policy: ExecutionPolicy, process: ProcessPolicyPort,
): string | null {
  if (!SETTABLE_SCOPES.includes(scope)) {
    return `Cannot set execution policy in the ${scope} scope: it is defined by Group Policy.`;
  }
  if (scope === 'Process') {
    process.write(policy === 'Undefined' ? null : policy);
    return null;
  }
  const key = SCOPE_KEY[scope]!;
  const registry = providers.registry;
  if (!registry) return 'No registry provider on this device.';
  if (policy === 'Undefined') {
    registry.removeItemProperty(key, 'ExecutionPolicy');
    return null;
  }
  if (!registry.testPath(key)) registry.newItem(key, true);
  registry.setItemProperty(key, 'ExecutionPolicy', policy);
  return null;
}

const FWLINK = 'https://go.microsoft.com/fwlink/?LinkID=135170';

export function scriptRefusal(policy: ExecutionPolicy, path: string): string | null {
  if (policy === 'Restricted') {
    return `File ${path} cannot be loaded because running scripts is disabled on this system. `
      + `For more information, see about_Execution_Policies at ${FWLINK}.`;
  }
  if (policy === 'AllSigned') {
    return `File ${path} cannot be loaded. The file ${path} is not digitally signed. `
      + `You cannot run this script on the current system. `
      + `For more information about running scripts and setting execution policy, `
      + `see about_Execution_Policies at ${FWLINK}.`;
  }
  return null;
}
