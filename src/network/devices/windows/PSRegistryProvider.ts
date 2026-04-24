/**
 * PSRegistryProvider — In-memory Windows Registry simulation.
 *
 * Supports HKLM:\ and HKCU:\ hive paths with:
 *   - Get-Item, Get-ChildItem, New-Item, Remove-Item
 *   - Get-ItemProperty, Set-ItemProperty, Remove-ItemProperty
 *   - Test-Path, Get-PSDrive
 */

// ─── Data Structures ─────────────────────────────────────────────────────────

export interface RegistryValue {
  name: string;
  value: string | number;
  type: 'String' | 'DWord' | 'QWord' | 'ExpandString' | 'MultiString' | 'Binary';
}

export interface RegistryKey {
  name: string;
  subkeys: Map<string, RegistryKey>;
  values: Map<string, RegistryValue>;
}

function makeKey(name: string): RegistryKey {
  return { name, subkeys: new Map(), values: new Map() };
}

function seedValue(key: RegistryKey, name: string, value: string | number, type: RegistryValue['type'] = 'String'): void {
  key.values.set(name.toLowerCase(), { name, value, type });
}

// ─── Seed data ───────────────────────────────────────────────────────────────

function buildHKLM(): RegistryKey {
  const root = makeKey('HKEY_LOCAL_MACHINE');

  // HKLM:\SOFTWARE
  const software = makeKey('SOFTWARE');
  root.subkeys.set('software', software);

  // HKLM:\SOFTWARE\Microsoft
  const microsoft = makeKey('Microsoft');
  software.subkeys.set('microsoft', microsoft);

  // HKLM:\SOFTWARE\Microsoft\Windows NT
  const windowsNT = makeKey('Windows NT');
  microsoft.subkeys.set('windows nt', windowsNT);

  // HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion
  const currentVersion = makeKey('CurrentVersion');
  windowsNT.subkeys.set('currentversion', currentVersion);
  seedValue(currentVersion, 'ProductName', 'Windows 11 Pro');
  seedValue(currentVersion, 'CurrentVersion', '10.0');
  seedValue(currentVersion, 'CurrentBuildNumber', '22621');
  seedValue(currentVersion, 'ReleaseId', '2009');
  seedValue(currentVersion, 'EditionID', 'Professional');
  seedValue(currentVersion, 'RegisteredOwner', 'User');
  seedValue(currentVersion, 'InstallationType', 'Client');

  // HKLM:\SOFTWARE\Microsoft\Windows
  const windows = makeKey('Windows');
  microsoft.subkeys.set('windows', windows);
  const currentVersionWin = makeKey('CurrentVersion');
  windows.subkeys.set('currentversion', currentVersionWin);

  // HKLM:\SOFTWARE\Classes
  software.subkeys.set('classes', makeKey('Classes'));

  // HKLM:\SOFTWARE\Policies
  software.subkeys.set('policies', makeKey('Policies'));

  // HKLM:\SOFTWARE\WOW6432Node
  software.subkeys.set('wow6432node', makeKey('WOW6432Node'));

  // HKLM:\SYSTEM
  const system = makeKey('SYSTEM');
  root.subkeys.set('system', system);
  const currentControlSet = makeKey('CurrentControlSet');
  system.subkeys.set('currentcontrolset', currentControlSet);
  const services = makeKey('Services');
  currentControlSet.subkeys.set('services', services);
  const control = makeKey('Control');
  currentControlSet.subkeys.set('control', control);

  // HKLM:\HARDWARE
  const hardware = makeKey('HARDWARE');
  root.subkeys.set('hardware', hardware);
  const description = makeKey('DESCRIPTION');
  hardware.subkeys.set('description', description);
  const systemDesc = makeKey('System');
  description.subkeys.set('system', systemDesc);
  seedValue(systemDesc, 'Identifier', 'AT/AT COMPATIBLE');

  // HKLM:\SAM
  root.subkeys.set('sam', makeKey('SAM'));

  // HKLM:\SECURITY
  root.subkeys.set('security', makeKey('SECURITY'));

  return root;
}

function buildHKCU(): RegistryKey {
  const root = makeKey('HKEY_CURRENT_USER');

  // HKCU:\Software
  const software = makeKey('Software');
  root.subkeys.set('software', software);

  // HKCU:\Software\Microsoft
  const microsoft = makeKey('Microsoft');
  software.subkeys.set('microsoft', microsoft);

  // HKCU:\Software\Microsoft\Windows
  const windows = makeKey('Windows');
  microsoft.subkeys.set('windows', windows);
  const currentVersion = makeKey('CurrentVersion');
  windows.subkeys.set('currentversion', currentVersion);

  // HKCU:\Environment
  const env = makeKey('Environment');
  root.subkeys.set('environment', env);
  seedValue(env, 'TEMP', '%USERPROFILE%\\AppData\\Local\\Temp');
  seedValue(env, 'TMP', '%USERPROFILE%\\AppData\\Local\\Temp');

  // HKCU:\Control Panel
  const controlPanel = makeKey('Control Panel');
  root.subkeys.set('control panel', controlPanel);

  // HKCU:\Console
  root.subkeys.set('console', makeKey('Console'));

  return root;
}

// ─── Path Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the path starts with a known registry hive prefix.
 */
export function isRegistryPath(path: string): boolean {
  const p = path.toUpperCase();
  return p.startsWith('HKLM:') || p.startsWith('HKCU:') ||
    p.startsWith('HKEY_LOCAL_MACHINE') || p.startsWith('HKEY_CURRENT_USER');
}

interface ParsedRegPath {
  hive: 'HKLM' | 'HKCU';
  /** segments after the root, e.g. ['SOFTWARE', 'Microsoft'] */
  segments: string[];
}

function parseRegistryPath(path: string): ParsedRegPath | null {
  // Normalise slashes
  let p = path.replace(/\//g, '\\').trim();
  // Remove trailing backslash
  if (p.endsWith('\\')) p = p.slice(0, -1);

  let hive: 'HKLM' | 'HKCU';
  let rest: string;

  const up = p.toUpperCase();
  if (up.startsWith('HKLM:\\') || up.startsWith('HKLM:')) {
    hive = 'HKLM';
    rest = p.slice(up.startsWith('HKLM:\\') ? 6 : 5);
  } else if (up.startsWith('HKCU:\\') || up.startsWith('HKCU:')) {
    hive = 'HKCU';
    rest = p.slice(up.startsWith('HKCU:\\') ? 6 : 5);
  } else if (up.startsWith('HKEY_LOCAL_MACHINE\\')) {
    hive = 'HKLM';
    rest = p.slice('HKEY_LOCAL_MACHINE\\'.length);
  } else if (up.startsWith('HKEY_CURRENT_USER\\')) {
    hive = 'HKCU';
    rest = p.slice('HKEY_CURRENT_USER\\'.length);
  } else if (up === 'HKLM:' || up === 'HKEY_LOCAL_MACHINE') {
    return { hive: 'HKLM', segments: [] };
  } else if (up === 'HKCU:' || up === 'HKEY_CURRENT_USER') {
    return { hive: 'HKCU', segments: [] };
  } else {
    return null;
  }

  const segments = rest ? rest.split('\\').filter(Boolean) : [];
  return { hive, segments };
}

// ─── Registry Provider ────────────────────────────────────────────────────────

export class PSRegistryProvider {
  private hklm: RegistryKey = buildHKLM();
  private hkcu: RegistryKey = buildHKCU();

  // ─── Internal navigation ──────────────────────────────────────────

  private hiveRoot(hive: 'HKLM' | 'HKCU'): RegistryKey {
    return hive === 'HKLM' ? this.hklm : this.hkcu;
  }

  private navigateTo(parsed: ParsedRegPath): RegistryKey | null {
    let current = this.hiveRoot(parsed.hive);
    for (const seg of parsed.segments) {
      const child = current.subkeys.get(seg.toLowerCase());
      if (!child) return null;
      current = child;
    }
    return current;
  }

  /** Ensure all intermediate keys exist (mkdir -p style). Returns the leaf. */
  private ensurePath(parsed: ParsedRegPath): RegistryKey {
    let current = this.hiveRoot(parsed.hive);
    for (const seg of parsed.segments) {
      const key = seg.toLowerCase();
      if (!current.subkeys.has(key)) {
        current.subkeys.set(key, makeKey(seg));
      }
      current = current.subkeys.get(key)!;
    }
    return current;
  }

  // ─── Public API ───────────────────────────────────────────────────

  testPath(path: string): boolean {
    const parsed = parseRegistryPath(path);
    if (!parsed) return false;
    return this.navigateTo(parsed) !== null;
  }

  getItem(path: string): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Get-Item : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Get-Item : Cannot find path '${path}' because it does not exist.`;

    const hivePath = parsed.hive === 'HKLM' ? 'HKLM:' : 'HKCU:';
    const fullPath = parsed.segments.length
      ? `${hivePath}\\${parsed.segments.join('\\')}`
      : hivePath;
    const subkeyCount = key.subkeys.size;
    const valueCount = key.values.size;

    return [
      '',
      `    Hive: ${parsed.segments.length > 0 ? `${hivePath}\\${parsed.segments.slice(0, -1).join('\\')}` : parsed.hive}`,
      '',
      'Name                           Property',
      '----                           --------',
      `${key.name.padEnd(30)} (${subkeyCount} subkeys, ${valueCount} values) [${fullPath}]`,
    ].join('\n');
  }

  getChildItem(path: string): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Get-ChildItem : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Get-ChildItem : Cannot find path '${path}' because it does not exist.`;

    const hivePath = parsed.hive === 'HKLM' ? 'HKLM:' : 'HKCU:';
    const parentPath = parsed.segments.length
      ? `${hivePath}\\${parsed.segments.join('\\')}`
      : hivePath;

    if (key.subkeys.size === 0) return '';

    const lines: string[] = [
      '',
      `    Hive: ${parentPath}`,
      '',
      'Name                           Property',
      '----                           --------',
    ];

    for (const [, child] of key.subkeys) {
      const valueCount = child.values.size;
      const prop = valueCount > 0 ? Array.from(child.values.values()).map(v => v.name).join(', ') : '';
      lines.push(`${child.name.padEnd(30)} ${prop}`);
    }

    return lines.join('\n');
  }

  newItem(path: string, force: boolean): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `New-Item : The path '${path}' is not a valid registry path.`;
    if (parsed.segments.length === 0) return `New-Item : Cannot create a key at the root of a hive.`;

    // Without -Force, parent must exist
    if (!force) {
      const parentSegments = parsed.segments.slice(0, -1);
      const parentParsed = { hive: parsed.hive, segments: parentSegments };
      if (!this.navigateTo(parentParsed)) {
        return `New-Item : Cannot create the item because the parent path does not exist. Use -Force to create parent keys.`;
      }
    }

    const key = this.ensurePath(parsed);
    const hivePath = parsed.hive === 'HKLM' ? 'HKLM:' : 'HKCU:';
    const fullPath = `${hivePath}\\${parsed.segments.join('\\')}`;
    return `\n\n    Hive: ${hivePath}\\${parsed.segments.slice(0, -1).join('\\') || ''}\n\nName                           Property\n----                           --------\n${key.name.padEnd(30)}\n`;
  }

  removeItem(path: string, recurse: boolean): string {
    const parsed = parseRegistryPath(path);
    if (!parsed || parsed.segments.length === 0) {
      return `Remove-Item : Cannot remove a registry hive root.`;
    }
    const parentParsed = { hive: parsed.hive, segments: parsed.segments.slice(0, -1) };
    const parent = this.navigateTo(parentParsed);
    if (!parent) return `Remove-Item : Cannot find path '${path}' because it does not exist.`;
    const leafKey = parsed.segments[parsed.segments.length - 1].toLowerCase();
    if (!parent.subkeys.has(leafKey)) {
      return `Remove-Item : Cannot find path '${path}' because it does not exist.`;
    }
    const child = parent.subkeys.get(leafKey)!;
    if (!recurse && child.subkeys.size > 0) {
      return `Remove-Item : The item has children and the Recurse parameter was not specified. If you are sure you want to remove it and all its children, specify the Recurse parameter.`;
    }
    parent.subkeys.delete(leafKey);
    return '';
  }

  getItemProperty(path: string, name?: string): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Get-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Get-ItemProperty : Cannot find path '${path}' because it does not exist.`;

    if (name) {
      const val = key.values.get(name.toLowerCase());
      if (!val) return `Get-ItemProperty : Property '${name}' does not exist at path '${path}'.`;
      return `\n${val.name.padEnd(20)}: ${val.value}\n`;
    }

    // List all values
    if (key.values.size === 0) return '';
    const lines: string[] = [''];
    for (const [, val] of key.values) {
      lines.push(`${val.name.padEnd(20)}: ${val.value}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  setItemProperty(path: string, name: string, value: string | number): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Set-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Set-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const type: RegistryValue['type'] = typeof value === 'number' ? 'DWord' : 'String';
    key.values.set(name.toLowerCase(), { name, value, type });
    return '';
  }

  removeItemProperty(path: string, name: string): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Remove-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Remove-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    if (!key.values.has(name.toLowerCase())) {
      return `Remove-ItemProperty : Property '${name}' does not exist at path '${path}'.`;
    }
    key.values.delete(name.toLowerCase());
    return '';
  }

  // ─── Get-PSDrive ──────────────────────────────────────────────────

  getPSDrive(): string {
    const lines: string[] = [
      '',
      'Name           Used (GB)     Free (GB) Provider      Root',
      '----           ---------     --------- --------      ----',
      'Alias                                  Alias',
      'C                  42.30        157.70 FileSystem    C:\\',
      'Cert                                   Certificate   \\',
      'D                                      FileSystem    D:\\',
      'Env                                    Environment',
      'Function                               Function',
      'HKCU                                   Registry      HKEY_CURRENT_USER',
      'HKLM                                   Registry      HKEY_LOCAL_MACHINE',
      'Variable                               Variable',
      'WSMan                                  WSMan',
      '',
    ];
    return lines.join('\n');
  }
}
