/**
 * WinRegCommand — `reg query | add | delete` for cmd.exe.
 *
 * Bridges cmd.exe's reg.exe to the PowerShell registry provider so changes
 * made from cmd are visible from `Get-ItemProperty HKCU:\…` in PS (and
 * vice versa). Extracted from WindowsPC; depends only on the registry
 * provider surface below.
 */

export interface WinRegistryProvider {
  testPath(psKey: string): boolean;
  newItem(psKey: string, force: boolean): unknown;
  setItemProperty(psKey: string, name: string, value: string | number): void;
  removeItemProperty(psKey: string, name: string): void;
  removeItem(psKey: string, recurse: boolean): void;
  getItemPropertyValues(psKey: string): Record<string, unknown> | null | undefined;
  listSubkeyNames(psKey: string): string[];
}

export function cmdReg(registry: WinRegistryProvider, args: string[]): string {
  if (args.length === 0) {
    return 'ERROR: Invalid syntax. Type "REG /?" for usage.';
  }
  const action = args[0].toLowerCase();
  const rawKey = args[1] ?? '';
  // `reg.exe` uses unprefixed HKCU\..., PS provider expects HKCU:\...
  const psKey = rawKey.replace(/^(HKCU|HKLM|HKCR|HKU|HKCC)\\/i, '$1:\\');
  if (action === 'query') {
    if (!registry.testPath(psKey)) {
      return 'ERROR: The system was unable to find the specified registry key or value.';
    }
    const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
    const recurse = args.some(a => a.toLowerCase() === '/s');
    const valueFilter = vIdx >= 0 ? args[vIdx + 1] : undefined;
    return formatRegQuery(registry, rawKey, psKey, valueFilter, recurse);
  }
  if (action === 'add') {
    const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
    const tIdx = args.findIndex(a => a.toLowerCase() === '/t');
    const dIdx = args.findIndex(a => a.toLowerCase() === '/d');
    registry.newItem(psKey, true);
    if (vIdx >= 0) {
      const valueName = args[vIdx + 1];
      const data: string | number = dIdx >= 0
        ? args[dIdx + 1].replace(/^"(.*)"$/, '$1')
        : '';
      const typ = tIdx >= 0 ? args[tIdx + 1].toUpperCase() : 'REG_SZ';
      const coerced: string | number = typ === 'REG_DWORD' ? Number(data) : data;
      registry.setItemProperty(psKey, valueName, coerced);
    }
    return 'The operation completed successfully.';
  }
  if (action === 'delete') {
    const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
    if (vIdx >= 0) {
      registry.removeItemProperty(psKey, args[vIdx + 1]);
    } else {
      registry.removeItem(psKey, true);
    }
    return 'The operation completed successfully.';
  }
  return 'ERROR: Invalid syntax.';
}

/**
 * Render a `reg query` result in the canonical reg.exe layout:
 *   <RootKey>\<Sub>\<Sub>
 *       Name    REG_TYPE    Value
 * Optionally filters to a single value (`/v Name`) or recurses (`/s`).
 */
function formatRegQuery(
  registry: WinRegistryProvider,
  rawKey: string,
  psKey: string,
  valueFilter: string | undefined,
  recurse: boolean,
): string {
  const lines: string[] = [];
  const visit = (currentRaw: string, currentPs: string): void => {
    const values = registry.getItemPropertyValues(currentPs);
    const subkeys = registry.listSubkeyNames(currentPs);
    lines.push('');
    lines.push(currentRaw);
    if (values) {
      for (const [name, val] of Object.entries(values)) {
        if (valueFilter && name.toLowerCase() !== valueFilter.toLowerCase()) continue;
        const t = typeof val === 'number' ? 'REG_DWORD' : 'REG_SZ';
        const v = typeof val === 'number' ? `0x${val.toString(16)}` : String(val);
        lines.push(`    ${name}    ${t}    ${v}`);
      }
    }
    if (recurse) {
      for (const sub of subkeys) {
        visit(`${currentRaw}\\${sub}`, `${currentPs}\\${sub}`);
      }
    }
  };
  visit(rawKey, psKey);
  lines.push('');
  return lines.join('\n');
}
