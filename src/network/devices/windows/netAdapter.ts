import { MACAddress } from '@/network/core/types';
import { hasWildcard, wildcardMatches } from '@/powershell/runtime/PSWildcard';
import { toDisplayName, toPortName } from './WindowsInterfaceNaming';
import { cimNotFound } from './cimQuery';

export type NetAdapterStatus = 'Up' | 'Disconnected' | 'Disabled';

export interface AdapterIdentity {
  portName: string;
  name: string;
}

export interface NetAdapterEntry extends AdapterIdentity {
  interfaceDescription: string;
  ifIndex: number;
  status: NetAdapterStatus;
  macAddress: string;
  linkSpeed: string;
  mtu: number;
  physical: boolean;
  hidden: boolean;
}

export interface NetAdapterSelection {
  name?: string[];
  interfaceDescription?: string[];
  interfaceIndex?: string[];
  includeHidden?: boolean;
  physical?: boolean;
}

function adapterNames(id: AdapterIdentity): string[] {
  return [id.name, id.portName, toDisplayName(id.portName)];
}

export function adapterMatches(id: AdapterIdentity, pattern: string): boolean {
  const typed = unquote(pattern);
  const names = adapterNames(id);
  if (hasWildcard(typed)) return names.some(n => wildcardMatches(typed, n));
  if (names.some(n => n.toLowerCase() === typed.toLowerCase())) return true;
  return toPortName(typed) === id.portName;
}

export function resolveAdapter<T extends AdapterIdentity>(
  rows: readonly T[], name: string,
): T | null {
  const typed = unquote(name);
  const wanted = typed.toLowerCase();
  const direct = rows.find(r => adapterNames(r).some(n => n.toLowerCase() === wanted));
  if (direct !== undefined) return direct;
  const spelled = toPortName(typed);
  return spelled === null ? null : rows.find(r => r.portName === spelled) ?? null;
}

function unquote(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '');
}

function fieldMatches(patterns: readonly string[], value: string): boolean {
  return patterns.some(p => hasWildcard(p)
    ? wildcardMatches(p, value)
    : unquote(p).toLowerCase() === value.toLowerCase());
}

export function selectNetAdapters<T extends NetAdapterEntry>(
  rows: readonly T[], selection: NetAdapterSelection,
): T[] {
  let kept = selection.includeHidden === true ? [...rows] : rows.filter(r => !r.hidden);
  if (selection.physical === true) kept = kept.filter(r => r.physical);
  if (selection.name !== undefined) {
    kept = kept.filter(r => selection.name!.some(p => adapterMatches(r, p)));
  }
  if (selection.interfaceDescription !== undefined) {
    kept = kept.filter(r => fieldMatches(selection.interfaceDescription!, r.interfaceDescription));
  }
  if (selection.interfaceIndex !== undefined) {
    const wanted = selection.interfaceIndex.map(v => v.trim());
    kept = kept.filter(r => wanted.includes(String(r.ifIndex)));
  }
  return kept;
}

const CIM_CLASS = 'MSFT_NetAdapter';

export function noMatchingNetAdapter(selection: NetAdapterSelection): string {
  return cimNotFound(CIM_CLASS, [
    ['Name', selection.name],
    ['InterfaceDescription', selection.interfaceDescription],
    ['InterfaceIndex', selection.interfaceIndex],
  ]);
}

export function selectionIsEmpty(selection: NetAdapterSelection): boolean {
  return selection.name === undefined
    && selection.interfaceDescription === undefined
    && selection.interfaceIndex === undefined;
}

export interface AdapterNamed { getName(): string; getAlias(): string | null }

export function identityOfPort(port: AdapterNamed): AdapterIdentity {
  const portName = port.getName();
  return { portName, name: port.getAlias() ?? toDisplayName(portName) };
}

export function resolveAdapterPortName(
  name: string, ports: Iterable<AdapterNamed>,
): string | null {
  return resolveAdapter([...ports].map(identityOfPort), name)?.portName ?? null;
}

export function adapterNameMatches(port: AdapterNamed, pattern: string): boolean {
  return adapterMatches(identityOfPort(port), pattern);
}

export function adapterDisplayName(
  portName: string, ports: ReadonlyMap<string, AdapterNamed>,
): string {
  return ports.get(portName)?.getAlias() ?? toDisplayName(portName);
}

export function parseNetAdapterMac(raw: string): MACAddress | null {
  const trimmed = raw.trim();
  const bare = trimmed.replace(/[:-]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(bare)) return null;
  const grouped = bare.match(/.{2}/g);
  if (grouped === null) return null;
  try {
    return new MACAddress(grouped.join(':'));
  } catch {
    return null;
  }
}

export function formatNetAdapterMac(mac: string): string {
  try { return new MACAddress(mac).toWindowsString(); }
  catch { return mac.toUpperCase(); }
}

export function adapterNameTaken(
  rows: readonly AdapterIdentity[], newName: string, exceptPort: string,
): boolean {
  const other = rows.filter(r => r.portName !== exceptPort);
  return resolveAdapter(other, newName) !== null;
}

export function adapterNameProblem(newName: string): string | null {
  const trimmed = newName.trim();
  if (trimmed.length === 0) return 'The network adapter name cannot be empty.';
  if (hasWildcard(trimmed)) {
    return `The network adapter name '${newName}' is not valid because it contains a wildcard character.`;
  }
  return null;
}

export const MULTIPLEXOR_DRIVER = 'Microsoft Network Adapter Multiplexor Driver';

export function windowsInterfaceDescription(model: string, ordinal: number): string {
  return ordinal <= 1 ? model : `${model} #${ordinal}`;
}
