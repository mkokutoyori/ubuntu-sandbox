
import { md5Crypt, ciscoType4, isCiscoType4, ciscoType8, ciscoType9, decryptType7 } from '@/crypto';

function decouperCrypt(valeur: string): { id: string; sel: string } | null {
  const m = /^\$(1|8|9)\$([^$]*)\$/.exec(valeur);
  if (!m) return null;
  return { id: m[1], sel: m[2] };
}

export function ciscoPasswordMatches(saisi: string, stocke: string, algo?: string): boolean {
  if (stocke === '') return false;
  if (algo === 'type-4') return ciscoType4(saisi) === stocke;

  const crypt = decouperCrypt(stocke);
  if (crypt) {
    if (crypt.sel === '') return false;
    try {
      switch (crypt.id) {
        case '1': return md5Crypt(saisi, crypt.sel) === stocke;
        case '8': return ciscoType8(saisi, crypt.sel) === stocke;
        case '9': return ciscoType9(saisi, crypt.sel) === stocke;
      }
    } catch { return false; }
    return false;
  }

  if (algo === 'type-7') {
    try { return decryptType7(stocke) === saisi; } catch { return false; }
  }

  return saisi === stocke;
}

const MODULAR_PREFIX: Readonly<Record<string, string>> = { 5: '$1$', 8: '$8$', 9: '$9$' };

export function isWellFormedSecret(type: string, value: string): boolean {
  if (type === '4') return isCiscoType4(value);
  const prefix = MODULAR_PREFIX[type];
  return prefix === undefined || value.startsWith(prefix);
}

export const TYPE4_DEPRECATION_WARNING =
  'WARNING: Command has been added to the configuration but Type 4 passwords have been deprecated.\n'
  + 'Migrate to a supported password type';

export function invalidEncryptedSecretMessage(type: string): string {
  return 'ERROR: The secret you entered is not a valid encrypted secret.\n'
    + `To enter an UNENCRYPTED secret, do not specify type ${type} encryption.\n`
    + 'When you properly enter an UNENCRYPTED secret, it will be encrypted.';
}
