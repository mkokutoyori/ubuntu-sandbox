
import { md5Crypt, ciscoType8, ciscoType9, decryptType7 } from '@/crypto';

function decouperCrypt(valeur: string): { id: string; sel: string } | null {
  const m = /^\$(1|8|9)\$([^$]*)\$/.exec(valeur);
  if (!m) return null;
  return { id: m[1], sel: m[2] };
}

export function ciscoPasswordMatches(saisi: string, stocke: string, algo?: string): boolean {
  if (stocke === '') return false;

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
