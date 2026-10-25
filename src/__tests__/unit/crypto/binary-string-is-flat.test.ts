/**
 * Mesure : bytesToBinaryString concatenait un caractere a la fois, ce qui laisse a V8 une corde (cons-string) de un noeud par octet, soit ~32 octets
 * par octet. Le fichier /var/log/lastlog d'un LinuxPC (292 292 octets) coutait ainsi 9,4 Mo de tas ; un laboratoire de 100 postes Linux montait a
 * 1,7 Go dans Chromium (e2e/grande-topologie.spec.ts) et 300 postes depassent le plafond du tas de l'onglet.
 *
 * Le texte est maintenant assemble par blocs de 8192 octets puis joint : une chaine plate.
 *
 * Discrimine par `git stash push -- src/crypto` : le cas du tas tombe (environ 9 Mo conserves par copie de 292 Ko, contre moins de 1 Mo). Passent
 * des deux cotes, TEMOINS : l'aller-retour des octets et les octets limites (0, 255, longueur qui n'est pas un multiple du bloc).
 */
import { describe, it, expect } from 'vitest';
import inspector from 'node:inspector';
import { bytesToBinaryString, binaryStringToBytes } from '@/crypto/encoding';

async function collectGarbage(): Promise<number> {
  const session = new inspector.Session();
  session.connect();
  await new Promise<void>((resolve, reject) => session.post('HeapProfiler.enable', (error) => (error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => session.post('HeapProfiler.collectGarbage', (error) => (error ? reject(error) : resolve())));
  session.disconnect();
  return process.memoryUsage().heapUsed;
}

describe('bytesToBinaryString rend une chaine plate', () => {
  it('20 copies de 292 292 octets pesent moins de 1 Mo chacune', async () => {
    const bytes = new Uint8Array(292292).map((_, i) => (i * 31) & 0xff);
    const before = await collectGarbage();
    const kept: string[] = [];
    for (let copy = 0; copy < 20; copy++) kept.push(bytesToBinaryString(bytes));
    const after = await collectGarbage();
    expect((after - before) / kept.length).toBeLessThan(1_000_000);
  }, 60_000);

  it('TEMOIN — l\'aller-retour rend les memes octets', () => {
    const lengths = [0, 1, 255, 8191, 8192, 8193, 20000];
    for (const length of lengths) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 7 + 255) & 0xff);
      expect(Array.from(binaryStringToBytes(bytesToBinaryString(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('TEMOIN — les octets limites donnent les codes 0 et 255', () => {
    const text = bytesToBinaryString(new Uint8Array([0, 255, 128]));
    expect([text.charCodeAt(0), text.charCodeAt(1), text.charCodeAt(2)]).toEqual([0, 255, 128]);
  });
});
