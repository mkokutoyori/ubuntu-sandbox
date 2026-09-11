import { matchEnumValue } from './netIpAddress';
import { applyCimCriteria, cimNotFound } from './cimQuery';
import type { NetFirewallDirection } from './netFirewallRule';

export type FirewallProfileName = 'Domain' | 'Private' | 'Public';

export const FIREWALL_PROFILE_NAMES: readonly FirewallProfileName[] =
  ['Domain', 'Private', 'Public'];

export type GpoBoolean = 'True' | 'False' | 'NotConfigured';

export const GPO_BOOLEANS: readonly GpoBoolean[] = ['False', 'True', 'NotConfigured'];

export type ProfileAction = 'NotConfigured' | 'Allow' | 'Block';

export const PROFILE_ACTIONS: readonly ProfileAction[] = ['NotConfigured', 'Allow', 'Block'];

export const DEFAULT_FIREWALL_LOG_FILE =
  '%windir%\\system32\\logfiles\\firewall\\pfirewall.log';
export const DEFAULT_FIREWALL_LOG_KILOBYTES = 4096;
export const MIN_FIREWALL_LOG_KILOBYTES = 1;
export const MAX_FIREWALL_LOG_KILOBYTES = 32767;

export const UNSOURCED_PROFILE_SETTINGS: readonly string[] =
  ['AllowUserApps', 'AllowUserPorts', 'EnableStealthModeForIPsec', 'DisabledInterfaceAliases'];

export function refusedProfileSetting(cmdlet: string, setting: string): string {
  return `${cmdlet} : The ${setting} setting is not implemented by this simulator:`
    + ' no Group Policy store and no per-application filtering engine back it,'
    + ' so accepting the value would render a setting nothing enforces.';
}

export interface NetFirewallProfileRow {
  name: FirewallProfileName;
  enabled: GpoBoolean;
  defaultInboundAction: ProfileAction;
  defaultOutboundAction: ProfileAction;
  allowInboundRules: GpoBoolean;
  allowLocalFirewallRules: GpoBoolean;
  allowLocalIPsecRules: GpoBoolean;
  allowUnicastResponseToMulticast: GpoBoolean;
  notifyOnListen: GpoBoolean;
  logAllowed: GpoBoolean;
  logBlocked: GpoBoolean;
  logIgnored: GpoBoolean;
  logFileName: string;
  logMaxSizeKilobytes: number;
}

export const ENFORCED_INBOUND_DEFAULT: ProfileAction = 'Allow';

function profileDefaults(name: FirewallProfileName): NetFirewallProfileRow {
  return {
    name,
    enabled: 'True',
    defaultInboundAction: ENFORCED_INBOUND_DEFAULT,
    defaultOutboundAction: 'Allow',
    allowInboundRules: 'True',
    allowLocalFirewallRules: 'True',
    allowLocalIPsecRules: 'True',
    allowUnicastResponseToMulticast: 'True',
    notifyOnListen: 'True',
    logAllowed: 'False',
    logBlocked: 'False',
    logIgnored: 'False',
    logFileName: DEFAULT_FIREWALL_LOG_FILE,
    logMaxSizeKilobytes: DEFAULT_FIREWALL_LOG_KILOBYTES,
  };
}

export function defaultFirewallProfiles(): Map<FirewallProfileName, NetFirewallProfileRow> {
  const store = new Map<FirewallProfileName, NetFirewallProfileRow>();
  resetFirewallProfiles(store);
  return store;
}

export function resetFirewallProfiles(
  store: Map<FirewallProfileName, NetFirewallProfileRow>,
): void {
  for (const name of FIREWALL_PROFILE_NAMES) store.set(name, profileDefaults(name));
}

export function profileForNetworkCategory(category: string): FirewallProfileName {
  if (category === 'DomainAuthenticated') return 'Domain';
  if (category === 'Private') return 'Private';
  return 'Public';
}

export function firewallIsOn(profile: NetFirewallProfileRow): boolean {
  return profile.enabled !== 'False';
}

export function rulesApplyTo(
  profile: NetFirewallProfileRow, direction: NetFirewallDirection,
): boolean {
  if (direction === 'Outbound') return true;
  return profile.allowInboundRules !== 'False';
}

export function defaultActionFor(
  profile: NetFirewallProfileRow, direction: NetFirewallDirection,
): 'Allow' | 'Block' {
  const stored = direction === 'Inbound'
    ? profile.defaultInboundAction : profile.defaultOutboundAction;
  if (stored === 'Allow' || stored === 'Block') return stored;
  return direction === 'Inbound' ? 'Block' : 'Allow';
}

export function readProfileName(raw: string): FirewallProfileName | null {
  return matchEnumValue(FIREWALL_PROFILE_NAMES, raw);
}

export function readGpoBoolean(raw: string): GpoBoolean | null {
  return matchEnumValue(GPO_BOOLEANS, raw);
}

export function readProfileAction(raw: string): ProfileAction | null {
  return matchEnumValue(PROFILE_ACTIONS, raw);
}

export function readLogSizeKilobytes(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = parseInt(raw.trim(), 10);
  if (value < MIN_FIREWALL_LOG_KILOBYTES || value > MAX_FIREWALL_LOG_KILOBYTES) return null;
  return value;
}

export interface NetFirewallProfileSelection {
  name?: readonly string[];
}

export function selectFirewallProfiles(
  rows: readonly NetFirewallProfileRow[], selection: NetFirewallProfileSelection,
): NetFirewallProfileRow[] {
  return applyCimCriteria(rows, [[selection.name, r => r.name]]);
}

export function noMatchingFirewallProfile(selection: NetFirewallProfileSelection): string {
  return cimNotFound('MSFT_NetFirewallProfile', [['Name', selection.name]]);
}
