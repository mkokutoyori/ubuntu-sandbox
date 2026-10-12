/**
 * L'ordre de `openssl ciphers` est celui du binaire réel : ssl_ciph.c énumère la table de s3_lib.c À REBOURS
 * (`ssl3_get_cipher(u)` rend `ssl3_ciphers[N - 1 - u]`, table triée par identifiant), de sorte que les suites à clés
 * égales sortent par identifiant décroissant — CCM8 avant CCM, la paire que la liste du simulateur inversait.
 * L'oracle est le vrai `openssl ciphers` ; les suites 3DES, absentes de la compilation Ubuntu (no-weak-ssl-ciphers)
 * mais décrites par le simulateur, sont écartées de la comparaison.
 *
 * MESURÉ avant correctif (git stash de src/network) : 3 cas sur 4 tombent (ALL, AESCCM, ALL:COMPLEMENTOFALL, toutes
 * trois sur l'ordre CCM/CCM8). Le témoin DEFAULT passe dans les deux états : CCM y est exclu (NOT_DEFAULT), aucune
 * paire CCM/CCM8 n'y figure.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createCipherList } from '@/network/tls/legacy/cipherString';

const realNames = (rule: string): string[] =>
  String(spawnSync('openssl', ['ciphers', rule], { encoding: 'utf8' }).stdout).trim().split(':').filter((name) => !name.startsWith('TLS_'));

const simNames = (rule: string): string[] => {
  const list = createCipherList(rule);
  return list.ok ? list.ciphers.map((cipher) => cipher.name).filter((name) => !name.includes('DES-CBC3')) : [];
};

describe('ordre de openssl ciphers face au binaire réel', () => {
  for (const rule of ['ALL', 'AESCCM', 'ALL:COMPLEMENTOFALL', 'DEFAULT']) {
    it(rule, () => {
      const real = realNames(rule);
      const sim = new Set(simNames(rule));
      expect(real.length).toBeGreaterThan(0);
      expect(simNames(rule)).toEqual(real.filter((name) => sim.has(name)));
    });
  }
});
