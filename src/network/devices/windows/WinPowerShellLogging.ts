/**
 * La journalisation PowerShell — Script Block Logging (4104) et
 * transcription.
 *
 * Les deux sont éteints par défaut et s'allument par la base de
 * registre, sous les clés de stratégie que Microsoft documente :
 *
 *   HKLM\SOFTWARE\Policies\Microsoft\PowerShellCore\ScriptBlockLogging
 *       EnableScriptBlockLogging : REG_DWORD  1 → 4104 pour chaque bloc
 *   HKLM\SOFTWARE\Policies\Microsoft\PowerShellCore\Transcription
 *       EnableTranscripting      : REG_DWORD  1
 *       OutputDirectory          : REG_SZ     où déposer les fichiers
 *
 * C'est la parade la plus efficace contre l'obfuscation : un
 * `-EncodedCommand` finit toujours par être décodé pour être exécuté, et
 * 4104 journalise le bloc *tel qu'il s'exécute*, pas tel qu'il a été
 * tapé. D'où l'intérêt de le lire dans une investigation.
 */

export const SCRIPT_BLOCK_LOGGING_KEY =
  'HKLM\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\ScriptBlockLogging';
export const TRANSCRIPTION_KEY =
  'HKLM\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\Transcription';

/** Le journal où atterrissent les 4104. */
export const POWERSHELL_OPERATIONAL_LOG = 'PowerShellCore/Operational';
export const POWERSHELL_PROVIDER = 'PowerShellCore';
export const SCRIPT_BLOCK_LOGGED = 4104;
export const PIPELINE_EXECUTION_DETAIL = 4103;
export const SCRIPT_BLOCK_INVOCATION_STARTED = 4105;
export const SCRIPT_BLOCK_INVOCATION_COMPLETED = 4106;

export interface RegistryValueReader {
  getItemPropertyValues(path: string): Record<string, unknown> | null | undefined;
}

/** Lecture insensible à la casse — `reg add` garde ce qu'on a tapé. */
export function readPolicyValue(
  registry: RegistryValueReader, key: string, name: string,
): unknown {
  const values = registry.getItemPropertyValues(key);
  if (!values) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(values)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/**
 * Un réglage de stratégie n'est actif que posé à 1. Contrairement aux
 * bascules du client DNS, celles-ci sont éteintes par défaut : c'est
 * l'absence qui vaut « non », parce que journaliser tout ce qu'exécute
 * un interpréteur coûte cher et se décide.
 */
function enabledWhenOne(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  const text = String(raw).trim().toLowerCase();
  return text !== '' && text !== '0' && text !== '0x0' && text !== 'false';
}

export interface PowerShellPolicySource {
  readonly registry: RegistryValueReader;
  readFile(path: string): string | null;
  readonly userConfigPath: string;
}

export const SYSTEM_CONFIG_PATH = 'C:\\Program Files\\PowerShell\\7\\powershell.config.json';

type PolicySection = 'ScriptBlockLogging' | 'Transcription' | 'ModuleLogging';

const SECTION_SETTINGS: Record<PolicySection, readonly string[]> = {
  ScriptBlockLogging: ['EnableScriptBlockLogging', 'EnableScriptBlockInvocationLogging'],
  Transcription: ['EnableTranscripting', 'EnableInvocationHeader', 'OutputDirectory'],
  ModuleLogging: ['EnableModuleLogging', 'ModuleNames'],
};

const CORE_POLICY_ROOT = 'SOFTWARE\\Policies\\Microsoft\\PowerShellCore';
const WINDOWS_POWERSHELL_POLICY_ROOT = 'SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell';
const FALLBACK_VALUE = 'UseWindowsPowerShellPolicySetting';

function hasAnySetting(values: Record<string, unknown>, section: PolicySection): boolean {
  const present = new Set(Object.keys(values).map((name) => name.toLowerCase()));
  return SECTION_SETTINGS[section].some((name) => present.has(name.toLowerCase()));
}

interface RegistryPolicy {
  readonly path: string;
  readonly values: Record<string, unknown>;
}

function registryPolicyAt(source: PowerShellPolicySource, section: PolicySection): RegistryPolicy | null {
  for (const hive of ['HKLM', 'HKCU']) {
    const corePath = `${hive}\\${CORE_POLICY_ROOT}\\${section}`;
    const core = source.registry.getItemPropertyValues(corePath);
    if (core === null || core === undefined) continue;
    const useWindowsPolicy = Number(readPolicyValue(source.registry, corePath, FALLBACK_VALUE)) === 1;
    const path = useWindowsPolicy ? `${hive}\\${WINDOWS_POWERSHELL_POLICY_ROOT}\\${section}` : corePath;
    const values = useWindowsPolicy ? source.registry.getItemPropertyValues(path) : core;
    if (values !== null && values !== undefined && hasAnySetting(values, section)) return { path, values };
  }
  return null;
}

function registryPolicy(source: PowerShellPolicySource, section: PolicySection): Record<string, unknown> | null {
  return registryPolicyAt(source, section)?.values ?? null;
}

function configFilePolicy(source: PowerShellPolicySource, section: PolicySection): Record<string, unknown> | null {
  for (const path of [SYSTEM_CONFIG_PATH, source.userConfigPath]) {
    const text = source.readFile(path);
    if (text === null) continue;
    try {
      const policies = (JSON.parse(text) as { PowerShellPolicies?: Record<string, unknown> }).PowerShellPolicies;
      const entry = policies === undefined ? undefined : Object.entries(policies).find(([name]) => name.toLowerCase() === section.toLowerCase())?.[1];
      if (entry !== null && typeof entry === 'object' && hasAnySetting(entry as Record<string, unknown>, section)) return entry as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

function policyValue(source: PowerShellPolicySource, section: PolicySection, name: string): unknown {
  const policy = registryPolicy(source, section) ?? configFilePolicy(source, section);
  if (policy === null) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(policy)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function isScriptBlockLoggingEnabled(source: PowerShellPolicySource): boolean {
  return enabledWhenOne(policyValue(source, 'ScriptBlockLogging', 'EnableScriptBlockLogging'));
}

export function isScriptBlockInvocationLoggingEnabled(source: PowerShellPolicySource): boolean {
  return enabledWhenOne(policyValue(source, 'ScriptBlockLogging', 'EnableScriptBlockInvocationLogging'));
}

export function loggedModuleNames(source: PowerShellPolicySource): readonly string[] {
  if (!enabledWhenOne(policyValue(source, 'ModuleLogging', 'EnableModuleLogging'))) return [];
  const registry = registryPolicyAt(source, 'ModuleLogging');
  if (registry !== null) return Object.keys(source.registry.getItemPropertyValues(`${registry.path}\\ModuleNames`) ?? {});
  const listed = policyValue(source, 'ModuleLogging', 'ModuleNames');
  return Array.isArray(listed) ? listed.map(String) : [];
}

export function moduleIsLogged(names: readonly string[], moduleName: string): boolean {
  return names.some((name) => {
    if (name.toLowerCase() === moduleName.toLowerCase()) return true;
    if (!/[*?[]/.test(name)) return false;
    const pattern = name.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${pattern}$`, 'i').test(moduleName);
  });
}

export function pipelineExecutionDetailMessage(details: readonly string[], context: readonly (readonly [string, string])[]): string {
  const payload = details.map((line) => `${line}\n`).join('');
  const contextInfo = context.map(([label, value]) => `${label} = ${value}\n`).join('');
  return `${payload}\nContext:\n${contextInfo}User Data:\n`;
}

export function isTranscriptionEnabled(source: PowerShellPolicySource): boolean {
  return enabledWhenOne(policyValue(source, 'Transcription', 'EnableTranscripting'));
}

export function transcriptDirectory(source: PowerShellPolicySource): string {
  const raw = policyValue(source, 'Transcription', 'OutputDirectory');
  const dir = raw === undefined || raw === null ? '' : String(raw).trim();
  return dir || 'C:\\Users\\User\\Documents';
}

/**
 * Le nom d'un fichier de transcription, au format de Windows :
 * `PowerShell_transcript.<MACHINE>.<jeton>.<horodatage>.txt`. Le jeton
 * distingue deux sessions ouvertes la même seconde ; il est dérivé de
 * l'horodatage plutôt que tiré au hasard, pour qu'une même session
 * retrouve son fichier.
 */
export function transcriptFileName(hostname: string, startedAt: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${startedAt.getFullYear()}${p(startedAt.getMonth() + 1)}${p(startedAt.getDate())}`
    + `${p(startedAt.getHours())}${p(startedAt.getMinutes())}${p(startedAt.getSeconds())}`;
  const token = stamp.slice(-8);
  return `PowerShell_transcript.${hostname.toUpperCase()}.${token}.${stamp}.txt`;
}

/**
 * L'identifiant d'un bloc de script — un GUID chez Windows. Il est
 * dérivé du texte plutôt que tiré au hasard : le même bloc exécuté deux
 * fois porte alors le même identifiant, ce qui est exactement ce à quoi
 * ce champ sert quand on recoupe des événements.
 */
export function scriptBlockId(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const a = h1.toString(16).padStart(8, '0');
  const b = h2.toString(16).padStart(8, '0');
  return `${a}-${b.slice(0, 4)}-${b.slice(4)}-${a.slice(0, 4)}-${a.slice(4)}${b}`;
}

/** L'en-tête que PowerShell écrit en tête de chaque transcription. */
export function transcriptHeader(hostname: string, user: string, startedAt: Date): string {
  return [
    '**********************',
    'PowerShell transcript start',
    `Start time: ${startedAt.toISOString()}`,
    `Username: ${user}`,
    `Machine: ${hostname.toUpperCase()}`,
    '**********************',
    '',
  ].join('\n');
}
