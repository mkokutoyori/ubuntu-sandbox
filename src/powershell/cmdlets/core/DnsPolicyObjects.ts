import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type {
  PolicyAction, PolicyContentEntry, PolicyCriteriaText, PolicyCriterionType, PolicyKind, PolicyView,
} from '@/powershell/providers/PSProviders';
import { psValueToString, registerPSDisplayFormatter } from '@/powershell/runtime/PSExpansion';

const CRITERIA_TYPE_NAME = 'DnsServerPolicyCriteria';

const CONTENT_TYPE_NAME = 'DnsServerPolicyContent';

registerPSDisplayFormatter(CRITERIA_TYPE_NAME, () => CRITERIA_TYPE_NAME);

registerPSDisplayFormatter(CONTENT_TYPE_NAME, () => CONTENT_TYPE_NAME);

function typed(typeName: string, fields: Record<string, PSValue>): Record<string, PSValue> {
  return Object.defineProperty({ ...fields }, '__type', { value: typeName, enumerable: false });
}

export const POLICY_CRITERIA_PARAMETERS: ReadonlyArray<{
  readonly parameter: string; readonly key: string; readonly type: PolicyCriterionType; readonly criteriaType: string;
}> = [
  { parameter: 'ClientSubnet', key: 'clientsubnet', type: 'clientSubnet', criteriaType: 'ClientSubnet' },
  { parameter: 'TransportProtocol', key: 'transportprotocol', type: 'transportProtocol', criteriaType: 'TransportProtocol' },
  { parameter: 'InternetProtocol', key: 'internetprotocol', type: 'internetProtocol', criteriaType: 'NetworkProtocol' },
  { parameter: 'ServerInterfaceIP', key: 'serverinterfaceip', type: 'serverInterface', criteriaType: 'Interface' },
  { parameter: 'Fqdn', key: 'fqdn', type: 'fqdn', criteriaType: 'Fqdn' },
  { parameter: 'QType', key: 'qtype', type: 'queryType', criteriaType: 'Qtype' },
  { parameter: 'TimeOfDay', key: 'timeofday', type: 'timeOfDay', criteriaType: 'Time' },
];

export function criteriaFromNamed(ctx: CmdletContext): PolicyCriteriaText {
  return Object.fromEntries(POLICY_CRITERIA_PARAMETERS.flatMap(({ key, type }) => {
    const given = ctx.named[key];
    return given === undefined ? [] : [[type, psValueToString(given)]];
  }));
}

export function contentFromText(text: string): PolicyContentEntry[] {
  return text.split(';').map(part => part.trim()).filter(part => part !== '').map(part => {
    const [scope, weight] = part.split(',').map(piece => piece.trim());
    return { scope, weight: weight === undefined || weight === '' ? 1 : Number(weight) };
  });
}

function capitalised(action: PolicyAction): string {
  return action.charAt(0) + action.slice(1).toLowerCase();
}

export function policyObject(view: PolicyView): Record<string, PSValue> {
  const criteria = POLICY_CRITERIA_PARAMETERS.flatMap(({ type, criteriaType }) => {
    const text = view.criteria[type];
    return text === null ? [] : [typed(CRITERIA_TYPE_NAME, { CriteriaType: criteriaType, Criteria: text })];
  });
  return {
    Action: capitalised(view.action),
    AppliesOn: view.kind,
    Condition: view.condition === 'AND' ? 'And' : 'Or',
    Content: view.content.length === 0 ? null : view.content.map(entry => typed(CONTENT_TYPE_NAME, { ScopeName: entry.scope, Weight: entry.weight })),
    Criteria: criteria,
    IsEnabled: view.enabled,
    Level: view.zone === null ? 'Server' : 'Zone',
    Name: view.name,
    ProcessingOrder: view.processingOrder,
    ZoneName: view.zone,
  };
}

function elementsOf(value: PSValue | undefined): Array<Record<string, PSValue>> {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items.filter((item): item is Record<string, PSValue> => item !== null && typeof item === 'object' && !Array.isArray(item));
}

export interface PolicyRecord {
  readonly name: string;
  readonly zone: string | null;
  readonly kind: PolicyKind | null;
  readonly action: PolicyAction | null;
  readonly condition: 'AND' | 'OR' | null;
  readonly enabled: boolean | null;
  readonly processingOrder: number | null;
  readonly criteria: PolicyCriteriaText;
  readonly content: PolicyContentEntry[];
}

const KINDS: readonly PolicyKind[] = ['QueryProcessing', 'Recursion', 'ZoneTransfer'];

export function policyFromRecord(record: Record<string, PSValue>): PolicyRecord {
  const text = (key: string): string | null => {
    const given = record[key];
    return given === undefined || given === null ? null : psValueToString(given);
  };
  const action = text('Action')?.toUpperCase();
  const condition = text('Condition')?.toUpperCase();
  const zone = text('ZoneName');
  const order = text('ProcessingOrder');
  const criteria = Object.fromEntries(elementsOf(record['Criteria']).flatMap(element => {
    const known = POLICY_CRITERIA_PARAMETERS.find(entry => entry.criteriaType === psValueToString(element['CriteriaType']));
    return known === undefined ? [] : [[known.type, psValueToString(element['Criteria'])]];
  }));
  return {
    name: text('Name') ?? '',
    zone: zone === null || zone === '' ? null : zone,
    kind: KINDS.find(kind => kind === text('AppliesOn')) ?? null,
    action: action === 'ALLOW' || action === 'DENY' || action === 'IGNORE' ? action : null,
    condition: condition === 'AND' || condition === 'OR' ? condition : null,
    enabled: record['IsEnabled'] === undefined || record['IsEnabled'] === null ? null : record['IsEnabled'] === true,
    processingOrder: order === null ? null : Number(order),
    criteria,
    content: elementsOf(record['Content']).map(element => ({
      scope: psValueToString(element['ScopeName']), weight: Number(psValueToString(element['Weight'])),
    })),
  };
}

export function positional(ctx: CmdletContext, key: string, position: number): string | undefined {
  const given = ctx.named[key] ?? ctx.positional[position];
  return given === undefined || given === null ? undefined : psValueToString(given);
}

export function zoneArgument(ctx: CmdletContext, position?: number): string | null {
  const given = ctx.named['zonename'] ?? (position === undefined ? undefined : ctx.positional[position]);
  return given === undefined || given === null || psValueToString(given) === '' ? null : psValueToString(given);
}

export function nameArgument(ctx: CmdletContext, position?: number): string {
  return psValueToString(ctx.named['name'] ?? (position === undefined ? undefined : ctx.positional[position]) ?? '');
}

export function policyName(ctx: CmdletContext, record: PolicyRecord | null, position?: number): string {
  const given = nameArgument(ctx, position);
  return given !== '' ? given : record?.name ?? '';
}

export function inputObject(ctx: CmdletContext): PolicyRecord | null {
  const given = ctx.named['inputobject'];
  return given === undefined || given === null || typeof given !== 'object' || Array.isArray(given)
    ? null
    : policyFromRecord(given as Record<string, PSValue>);
}

export function mergedCriteria(named: PolicyCriteriaText, record: PolicyRecord | null): PolicyCriteriaText {
  return { ...(record?.criteria ?? {}), ...named };
}
