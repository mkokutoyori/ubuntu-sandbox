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
  type: RegistryValueType;
}

export type RegistryValueType =
  | 'String' | 'DWord' | 'QWord' | 'ExpandString' | 'MultiString' | 'Binary'
  | 'None' | 'DWordBigEndian' | 'Link' | 'ResourceList';

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

/** The subset of registry values that differ between a Windows client and a Windows Server install. */
export interface WindowsProductIdentity {
  productName: string;
  currentBuildNumber: string;
  releaseId: string;
  editionId: string;
  installationType: 'Client' | 'Server';
}

export const WINDOWS_CLIENT_PRODUCT_IDENTITY: WindowsProductIdentity = {
  productName: 'Windows 10 Pro',
  currentBuildNumber: '22631',
  releaseId: '2009',
  editionId: 'Professional',
  installationType: 'Client',
};

export const WINDOWS_SERVER_PRODUCT_IDENTITY: WindowsProductIdentity = {
  productName: 'Windows Server 2022 Standard',
  currentBuildNumber: '20348',
  releaseId: '2009',
  editionId: 'ServerStandard',
  installationType: 'Server',
};

export type RegistryRoot = 'HKLM' | 'HKCU' | 'HKCR' | 'HKU' | 'HKCC';

export interface RegistryAddress {
  readonly root: RegistryRoot;
  readonly segments: readonly string[];
  readonly machine: string | null;
}

export interface RegistryKeyView {
  readonly name: string;
  readonly values: readonly RegistryValue[];
  readonly subkeys: readonly string[];
}

export const REGISTRY_ROOT_NAMES: Readonly<Record<RegistryRoot, string>> = {
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCU: 'HKEY_CURRENT_USER',
  HKCR: 'HKEY_CLASSES_ROOT',
  HKU: 'HKEY_USERS',
  HKCC: 'HKEY_CURRENT_CONFIG',
};

const ROOT_ALIASES: Readonly<Record<string, RegistryRoot>> = {
  hklm: 'HKLM', hkey_local_machine: 'HKLM',
  hkcu: 'HKCU', hkey_current_user: 'HKCU',
  hkcr: 'HKCR', hkey_classes_root: 'HKCR',
  hku: 'HKU', hkey_users: 'HKU',
  hkcc: 'HKCC', hkey_current_config: 'HKCC',
};

export function parseRegistryAddress(text: string): RegistryAddress | null {
  let rest = text.trim();
  let machine: string | null = null;
  const remote = /^\\\\([^\\]+)\\(.*)$/.exec(rest);
  if (remote) {
    machine = remote[1];
    rest = remote[2];
  }
  const parts = rest.split('\\').filter(part => part !== '');
  const root = parts.length > 0 ? ROOT_ALIASES[parts[0].toLowerCase()] : undefined;
  if (root === undefined) return null;
  return { root, segments: parts.slice(1), machine };
}

const FILE_ASSOCIATIONS: ReadonlyArray<readonly [extension: string, progId: string, openCommand: string | null]> = [
  ['.txt', 'txtfile', '%SystemRoot%\\system32\\NOTEPAD.EXE %1'],
  ['.log', 'txtfile', null],
  ['.ini', 'inifile', '%SystemRoot%\\system32\\NOTEPAD.EXE %1'],
  ['.bat', 'batfile', '"%1" %*'],
  ['.cmd', 'cmdfile', '"%1" %*'],
  ['.exe', 'exefile', '"%1" %*'],
  ['.com', 'comfile', '"%1" %*'],
  ['.vbs', 'VBSFile', '"%SystemRoot%\\System32\\WScript.exe" "%1" %*'],
  ['.js', 'JSFile', '"%SystemRoot%\\System32\\WScript.exe" "%1" %*'],
  ['.reg', 'regfile', 'regedit.exe "%1"'],
  ['.msi', 'Msi.Package', '"%SystemRoot%\\System32\\msiexec.exe" /i "%1" %*'],
  ['.inf', 'inffile', '%SystemRoot%\\System32\\InfDefaultInstall.exe "%1"'],
  ['.scr', 'scrfile', '"%1" /S'],
  ['.dll', 'dllfile', null],
  ['.sys', 'sysfile', null],
  ['.lnk', 'lnkfile', null],
  ['.url', 'InternetShortcut', null],
  ['.zip', 'CompressedFolder', null],
  ['.htm', 'htmlfile', null],
  ['.html', 'htmlfile', null],
  ['.bmp', 'Paint.Picture', null],
];

function seedClasses(classes: RegistryKey): void {
  for (const [extension, progId, openCommand] of FILE_ASSOCIATIONS) {
    const extensionKey = classes.subkeys.get(extension) ?? makeKey(extension);
    classes.subkeys.set(extension, extensionKey);
    seedValue(extensionKey, '', progId);
    if (openCommand === null) continue;
    const progKey = classes.subkeys.get(progId.toLowerCase()) ?? makeKey(progId);
    classes.subkeys.set(progId.toLowerCase(), progKey);
    const shell = progKey.subkeys.get('shell') ?? makeKey('shell');
    progKey.subkeys.set('shell', shell);
    const open = makeKey('open');
    shell.subkeys.set('open', open);
    const command = makeKey('command');
    open.subkeys.set('command', command);
    seedValue(command, '', openCommand, 'ExpandString');
  }
}

function buildHKLM(product: WindowsProductIdentity): RegistryKey {
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
  seedValue(currentVersion, 'ProductName', product.productName);
  seedValue(currentVersion, 'CurrentVersion', '10.0');
  seedValue(currentVersion, 'CurrentBuildNumber', product.currentBuildNumber);
  seedValue(currentVersion, 'ReleaseId', product.releaseId);
  seedValue(currentVersion, 'EditionID', product.editionId);
  seedValue(currentVersion, 'RegisteredOwner', 'User');
  seedValue(currentVersion, 'InstallationType', product.installationType);

  // HKLM:\SOFTWARE\Microsoft\Windows
  const windows = makeKey('Windows');
  microsoft.subkeys.set('windows', windows);
  const currentVersionWin = makeKey('CurrentVersion');
  windows.subkeys.set('currentversion', currentVersionWin);

  // HKLM:\SOFTWARE\Classes
  const classes = makeKey('Classes');
  software.subkeys.set('classes', classes);
  seedClasses(classes);

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

function buildHKU(): RegistryKey {
  const root = makeKey('HKEY_USERS');
  for (const name of ['.DEFAULT', 'S-1-5-18', 'S-1-5-19', 'S-1-5-20']) {
    const user = makeKey(name);
    root.subkeys.set(name.toLowerCase(), user);
    user.subkeys.set('software', makeKey('Software'));
    user.subkeys.set('environment', makeKey('Environment'));
  }
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

  // HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings
  const internetSettings = makeKey('Internet Settings');
  currentVersion.subkeys.set('internet settings', internetSettings);
  seedValue(internetSettings, 'ProxyEnable', 0);
  seedValue(internetSettings, 'ProxyServer', '');
  seedValue(internetSettings, 'ProxyOverride', '<local>');

  // HKCU:\Environment
  const env = makeKey('Environment');
  root.subkeys.set('environment', env);
  seedValue(env, 'TEMP', '%USERPROFILE%\\AppData\\Local\\Temp', 'ExpandString');
  seedValue(env, 'TMP', '%USERPROFILE%\\AppData\\Local\\Temp', 'ExpandString');

  // HKCU:\Control Panel
  const controlPanel = makeKey('Control Panel');
  root.subkeys.set('control panel', controlPanel);

  // HKCU:\Console
  root.subkeys.set('console', makeKey('Console'));

  return root;
}

const POWERSHELL_DEFAULT = '(default)';

function storedName(name: string): string {
  return name.toLowerCase() === POWERSHELL_DEFAULT ? '' : name;
}

function shownName(name: string): string {
  return name === '' ? POWERSHELL_DEFAULT : name;
}

function byRegistryName(left: string, right: string): number {
  return left.toLowerCase().localeCompare(right.toLowerCase());
}

// ─── Path Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the path starts with a known registry hive prefix.
 */
const HIVE_FULL_NAME: Record<string, string> = {
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCU: 'HKEY_CURRENT_USER',
};

export function registryProviderPath(path: string): string {
  const parsed = parseRegistryPath(path);
  if (parsed === null) return path;
  const full = HIVE_FULL_NAME[parsed.hive] ?? parsed.hive;
  return [full, ...parsed.segments].join('\\');
}

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
  } else if (up.startsWith('HKLM\\')) {
    // GPO key strings (e.g. Set-GPRegistryValue -Key) conventionally omit
    // the PSDrive colon real interactive `Get-Item`/`Set-ItemProperty`
    // paths require — same hive, no drive semantics involved.
    hive = 'HKLM';
    rest = p.slice(5);
  } else if (up.startsWith('HKCU\\')) {
    hive = 'HKCU';
    rest = p.slice(5);
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

/**
 * Ce qu'une écriture dans la base a changé — de quoi remplir un 4657,
 * dont l'intérêt tient entièrement à l'ancienne et à la nouvelle valeur.
 */
export interface RegistryValueChange {
  path: string;
  name: string;
  previous?: string | number;
  next: string | number;
}

export class PSRegistryProvider {
  private hklm: RegistryKey;
  private hkcu: RegistryKey = buildHKCU();
  private hku: RegistryKey = buildHKU();
  currentUserSid: () => string = () => 'S-1-5-21-1000000000-1000000000-1000000000-1001';

  /**
   * Notifié après toute écriture, quel qu'en soit le chemin — `reg add`
   * de cmd, `Set-ItemProperty` de PowerShell, ou une stratégie de
   * groupe. Sans ce fil, une valeur de stratégie qui commande un service
   * ne serait relue qu'au prochain démarrage : poser `EnableMulticast`
   * à zéro afficherait « opération réussie » pendant que le port reste
   * ouvert, ce qui est exactement le genre de réglage décoratif que ce
   * dépôt refuse.
   */
  onValueChanged: ((change?: RegistryValueChange) => void) | null = null;

  constructor(product: WindowsProductIdentity = WINDOWS_CLIENT_PRODUCT_IDENTITY) {
    this.hklm = buildHKLM(product);
  }

  private notifyChanged(change?: RegistryValueChange): void {
    this.onValueChanged?.(change);
  }

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
      const prop = valueCount > 0 ? Array.from(child.values.values()).map(v => shownName(v.name)).join(', ') : '';
      lines.push(`${child.name.padEnd(30)} ${prop}`);
    }

    return lines.join('\n');
  }

  targetsMachineHive(path: string): boolean {
    return parseRegistryPath(path)?.hive === 'HKLM';
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
    this.notifyChanged();
    return '';
  }

  getItemProperty(path: string, name?: string): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Get-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Get-ItemProperty : Cannot find path '${path}' because it does not exist.`;

    if (name) {
      const val = key.values.get(storedName(name).toLowerCase());
      if (!val) return `Get-ItemProperty : Property '${name}' does not exist at path '${path}'.`;
      return `\n${shownName(val.name).padEnd(20)}: ${val.value}\n`;
    }

    // List all values
    if (key.values.size === 0) return '';
    const lines: string[] = [''];
    for (const [, val] of key.values) {
      lines.push(`${shownName(val.name).padEnd(20)}: ${val.value}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Structured accessor used by the PowerShell cmdlet to build a PS object
   * whose own properties match registry value names. Preserves casing of the
   * stored names so `(Get-ItemProperty ...).Version` resolves naturally.
   */
  getItemPropertyValues(path: string): Record<string, string | number> | null {
    const parsed = parseRegistryPath(path);
    if (!parsed) return null;
    const key = this.navigateTo(parsed);
    if (!key) return null;
    const out: Record<string, string | number> = {};
    for (const [, val] of key.values) out[shownName(val.name)] = val.value;
    return out;
  }


  // ─── Typed access (reg.exe, assoc, ftype) ─────────────────────────

  private static readonly HARDWARE_PROFILE = ['SYSTEM', 'CurrentControlSet', 'Hardware Profiles', 'Current'];

  private descend(base: RegistryKey, segments: readonly string[], create: boolean): RegistryKey | null {
    let current = base;
    for (const segment of segments) {
      const key = segment.toLowerCase();
      let child = current.subkeys.get(key);
      if (!child) {
        if (!create) return null;
        child = makeKey(segment);
        current.subkeys.set(key, child);
      }
      current = child;
    }
    return current;
  }

  private classesParts(segments: readonly string[], create: boolean): { machine: RegistryKey | null; user: RegistryKey | null } {
    return {
      machine: this.descend(this.hklm, ['SOFTWARE', 'Classes', ...segments], create),
      user: this.descend(this.hkcu, ['Software', 'Classes', ...segments], false),
    };
  }

  private plainKey(address: RegistryAddress, create: boolean): RegistryKey | null {
    switch (address.root) {
      case 'HKLM': return this.descend(this.hklm, address.segments, create);
      case 'HKCU': return this.descend(this.hkcu, address.segments, create);
      case 'HKCC': return this.descend(this.hklm, [...PSRegistryProvider.HARDWARE_PROFILE, ...address.segments], create);
      case 'HKU': {
        const [first, ...rest] = address.segments;
        if (first !== undefined && first.toLowerCase() === this.currentUserSid().toLowerCase()) return this.descend(this.hkcu, rest, create);
        return this.descend(this.hku, address.segments, create && first !== undefined && this.hku.subkeys.has(first.toLowerCase()));
      }
      case 'HKCR': return null;
    }
  }

  private writableKey(address: RegistryAddress): RegistryKey | null {
    if (address.root !== 'HKCR') return this.plainKey(address, true);
    const { user } = this.classesParts(address.segments, false);
    return user ?? this.classesParts(address.segments, true).machine;
  }

  writesUserHive(address: RegistryAddress): boolean {
    switch (address.root) {
      case 'HKCU': return true;
      case 'HKU': return address.segments[0]?.toLowerCase() === this.currentUserSid().toLowerCase();
      case 'HKCR': return this.classesParts(address.segments, false).user !== null;
      default: return false;
    }
  }

  keyView(address: RegistryAddress): RegistryKeyView | null {
    if (address.root !== 'HKCR') {
      const key = this.plainKey(address, false);
      if (key === null) return null;
      return {
        name: address.segments.length === 0 ? REGISTRY_ROOT_NAMES[address.root] : key.name,
        values: [...key.values.values()],
        subkeys: [...key.subkeys.values()].map(child => child.name).sort(byRegistryName),
      };
    }
    const { machine, user } = this.classesParts(address.segments, false);
    if (machine === null && user === null) return null;
    const values = new Map<string, RegistryValue>();
    for (const key of [machine, user]) {
      if (key === null) continue;
      for (const [name, value] of key.values) values.set(name, value);
    }
    const subkeys = new Map<string, string>();
    for (const key of [machine, user]) {
      if (key === null) continue;
      for (const [name, child] of key.subkeys) if (!subkeys.has(name)) subkeys.set(name, child.name);
    }
    return {
      name: address.segments.length === 0 ? REGISTRY_ROOT_NAMES.HKCR : (machine ?? user)!.name,
      values: [...values.values()],
      subkeys: [...subkeys.values()].sort(byRegistryName),
    };
  }

  createKey(address: RegistryAddress): boolean {
    if (address.segments.length === 0) return false;
    return this.writableKey(address) !== null;
  }

  setValue(address: RegistryAddress, name: string, type: RegistryValueType, value: string | number): boolean {
    const key = this.writableKey(address);
    if (key === null) return false;
    const previous = key.values.get(name.toLowerCase())?.value;
    key.values.set(name.toLowerCase(), { name, value, type });
    this.notifyChanged({ path: this.displayPath(address), name, previous, next: value });
    return true;
  }

  deleteValue(address: RegistryAddress, name: string): boolean {
    const key = this.writableKey(address);
    const existing = key?.values.get(name.toLowerCase());
    if (key === null || existing === undefined) return false;
    key.values.delete(name.toLowerCase());
    this.notifyChanged({ path: this.displayPath(address), name, previous: existing.value, next: '' });
    return true;
  }

  deleteAllValues(address: RegistryAddress): boolean {
    const key = this.writableKey(address);
    if (key === null) return false;
    for (const value of [...key.values.values()]) this.deleteValue(address, value.name);
    return true;
  }

  deleteKey(address: RegistryAddress): boolean {
    if (address.segments.length === 0) return false;
    const parent = this.writableKey({ ...address, segments: address.segments.slice(0, -1) });
    const leaf = address.segments[address.segments.length - 1].toLowerCase();
    if (parent === null || !parent.subkeys.has(leaf)) return false;
    parent.subkeys.delete(leaf);
    this.notifyChanged();
    return true;
  }

  private displayPath(address: RegistryAddress): string {
    const hive = address.root === 'HKCR' ? 'HKCR' : address.root;
    return [`${hive}:`, ...address.segments].join('\\');
  }

  /** List immediate subkey names (preserving their original casing). */
  listSubkeyNames(path: string): string[] {
    const parsed = parseRegistryPath(path);
    if (!parsed) return [];
    const key = this.navigateTo(parsed);
    if (!key) return [];
    return Array.from(key.subkeys.values()).map(k => k.name);
  }

  /**
   * Keeps `HKLM:\SYSTEM\CurrentControlSet\Services\<name>` coherent with the
   * live `WindowsServiceManager` — the same account/start-type/binary a
   * security audit script reads via `sc qc`/`Get-Service`, exposed through
   * the registry surface real tooling (and real attackers) also targets.
   */
  upsertServiceKey(name: string, fields: { objectName: string; startCode: number; imagePath: string }): void {
    const key = this.ensurePath({ hive: 'HKLM', segments: ['SYSTEM', 'CurrentControlSet', 'Services', name] });
    seedValue(key, 'ObjectName', fields.objectName);
    seedValue(key, 'Start', fields.startCode, 'DWord');
    seedValue(key, 'ImagePath', fields.imagePath, 'ExpandString');
  }

  /**
   * The other half of `upsertServiceKey`: `sc delete` removes the key as
   * well as the service. Leaving it behind would have the SCM re-read a
   * service on the next boot that nobody can start.
   */
  removeServiceKey(name: string): void {
    const services = this.navigateTo({
      hive: 'HKLM', segments: ['SYSTEM', 'CurrentControlSet', 'Services'],
    });
    services?.subkeys.delete(name.toLowerCase());
  }

  /**
   * `gpupdate` writing a `Set-GPRegistryValue` policy entry into the local
   * hive — unlike the interactive `Set-ItemProperty` cmdlet, real Group
   * Policy Client creates whatever key path is missing (it isn't asking
   * the admin to pre-create `HKLM:\Software\Policies\...` by hand).
   */
  applyGpoRegistryValue(path: string, name: string, value: string | number, type: RegistryValue['type']): void {
    const parsed = parseRegistryPath(path);
    if (!parsed) return;
    const key = this.ensurePath(parsed);
    const previous = key.values.get(name.toLowerCase())?.value;
    seedValue(key, name, value, type);
    this.notifyChanged({ path, name, previous, next: value });
  }

  setItemProperty(path: string, name: string, value: string | number): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Set-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Set-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const stored = storedName(name);
    const type: RegistryValue['type'] = typeof value === 'number' ? 'DWord' : 'String';
    const previous = key.values.get(stored.toLowerCase())?.value;
    key.values.set(stored.toLowerCase(), { name: stored, value, type });
    this.notifyChanged({ path, name: stored, previous, next: value });
    return '';
  }

  removeItemProperty(path: string, name: string): string {
    const parsed = parseRegistryPath(path);
    if (!parsed) return `Remove-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const key = this.navigateTo(parsed);
    if (!key) return `Remove-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    const stored = storedName(name);
    if (!key.values.has(stored.toLowerCase())) {
      return `Remove-ItemProperty : Property '${name}' does not exist at path '${path}'.`;
    }
    const removed = key.values.get(stored.toLowerCase())?.value;
    key.values.delete(stored.toLowerCase());
    this.notifyChanged({ path, name: stored, previous: removed, next: '' });
    return '';
  }

  // ─── Get-PSDrive ──────────────────────────────────────────────────

  /**
   * Caller passes the filesystem-mounted drives — each with its live
   * Used/Free byte counts — so the PSDrive listing stays coherent with
   * `vol`, `Get-Volume`, `dir`'s "bytes free" line, and the bare
   * `D:`/`E:` cmd drive-switch handler. Hardcoding a fixed C/D table
   * caused Get-PSDrive to advertise drives the FS never created — and
   * to silently omit drives the FS did create — while pinning the used
   * column at "42.30" no matter how full the volume actually was.
   */
  getPSDrive(fsDrives: ReadonlyArray<{ letter: string; usedGB: number; freeGB: number }> = []): string {
    const fmtCol = (n: number, width: number): string =>
      n.toFixed(2).padStart(width);
    const fsLines = fsDrives.map(({ letter, usedGB, freeGB }) => {
      const L = letter.toUpperCase();
      // Match real PS column widths: Used (GB) and Free (GB) right-aligned.
      const used = fmtCol(usedGB, 14);
      const free = fmtCol(freeGB, 14);
      return `${L.padEnd(15)}${used}${free} FileSystem    ${L}:\\`;
    });
    const lines: string[] = [
      '',
      'Name           Used (GB)     Free (GB) Provider      Root',
      '----           ---------     --------- --------      ----',
      'Alias                                  Alias',
      ...fsLines,
      'Cert                                   Certificate   \\',
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
