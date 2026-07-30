/**
 * La journalisation PowerShell — Script Block Logging (4104) et
 * transcription.
 *
 * Les deux sont éteints par défaut et s'allument par la base de
 * registre, sous les clés de stratégie que Microsoft documente :
 *
 *   HKLM\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging
 *       EnableScriptBlockLogging : REG_DWORD  1 → 4104 pour chaque bloc
 *   HKLM\SOFTWARE\Policies\Microsoft\Windows\PowerShell\Transcription
 *       EnableTranscripting      : REG_DWORD  1
 *       OutputDirectory          : REG_SZ     où déposer les fichiers
 *
 * C'est la parade la plus efficace contre l'obfuscation : un
 * `-EncodedCommand` finit toujours par être décodé pour être exécuté, et
 * 4104 journalise le bloc *tel qu'il s'exécute*, pas tel qu'il a été
 * tapé. D'où l'intérêt de le lire dans une investigation.
 */

export const SCRIPT_BLOCK_LOGGING_KEY =
  'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging';
export const TRANSCRIPTION_KEY =
  'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription';

/** Le journal où atterrissent les 4104. */
export const POWERSHELL_OPERATIONAL_LOG = 'Microsoft-Windows-PowerShell/Operational';
export const POWERSHELL_PROVIDER = 'Microsoft-Windows-PowerShell';
export const SCRIPT_BLOCK_LOGGED = 4104;

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

export function isScriptBlockLoggingEnabled(registry: RegistryValueReader): boolean {
  return enabledWhenOne(
    readPolicyValue(registry, SCRIPT_BLOCK_LOGGING_KEY, 'EnableScriptBlockLogging'));
}

export function isTranscriptionEnabled(registry: RegistryValueReader): boolean {
  return enabledWhenOne(readPolicyValue(registry, TRANSCRIPTION_KEY, 'EnableTranscripting'));
}

export function transcriptDirectory(registry: RegistryValueReader): string {
  const raw = readPolicyValue(registry, TRANSCRIPTION_KEY, 'OutputDirectory');
  const dir = raw === undefined || raw === null ? '' : String(raw).trim();
  // Sans répertoire déclaré, Windows dépose la transcription dans les
  // documents de l'utilisateur. Un chemin vide n'est pas une raison de
  // ne rien écrire.
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
    'Windows PowerShell transcript start',
    `Start time: ${startedAt.toISOString()}`,
    `Username: ${user}`,
    `Machine: ${hostname.toUpperCase()}`,
    '**********************',
    '',
  ].join('\n');
}
