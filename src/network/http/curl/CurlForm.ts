/**
 * `-F` — le corps `multipart/form-data` de curl (RFC 7578).
 *
 * C'est la seule option de §P4 qui demandait à ÉCRIRE quelque chose
 * plutôt qu'à brancher un moteur existant : il n'y avait nulle part de
 * sérialiseur multipart. Ce qu'elle ne demandait pas, en revanche,
 * c'est une brique nouvelle — lire un fichier et assembler des octets
 * sont deux choses que ce curl fait déjà.
 */

import { LITTERAL } from './CurlArgs';
import { contentTypeForPath } from '../HttpTypes';

export interface FormPart {
  readonly name: string;
  readonly value: string;
  /** Présent quand la partie est un FICHIER : `-F champ=@chemin`. */
  readonly filename?: string;
  readonly contentType?: string;
}

export type FormBuild =
  | { ok: true; boundary: string; body: string; contentType: string }
  | { ok: false; message: string; code: number };

/**
 * La frontière de curl : `------------------------` suivi de chiffres.
 * Elle est tirée au hasard chez lui, et l'est aussi ici — une frontière
 * fixe finirait par apparaître dans un contenu et couperait le corps en
 * deux. Les tests s'accrochent donc à sa FORME et à sa présence des
 * deux côtés (en-tête et corps), jamais à sa valeur.
 */
function makeBoundary(): string {
  let chiffres = '';
  for (let i = 0; i < 16; i++) chiffres += Math.floor(Math.random() * 10);
  return `------------------------${chiffres}`;
}

/**
 * `-F champ=valeur`, `-F champ=@fichier`, `-F champ=<fichier`.
 *
 * Les trois formes ne disent pas la même chose et les confondre serait
 * le défaut :
 *   - `@` TÉLÉVERSE — la partie porte un `filename` et un type ;
 *   - `<` prend le CONTENU du fichier comme valeur, sans nom de
 *     fichier, ce qui est un champ ordinaire dont la valeur vient
 *     d'ailleurs ;
 *   - sans marque, la valeur est littérale.
 */
export function parseFormPart(
  spec: string, lire: (chemin: string) => string | null,
): { ok: true; part: FormPart } | { ok: false; message: string; code: number } {
  const eq = spec.indexOf('=');
  if (eq <= 0) {
    return {
      ok: false, code: 2,
      message: `curl: (2) Illegally formatted input field: '${spec}'`,
    };
  }
  const name = spec.slice(0, eq);
  const brut = spec.slice(eq + 1);

  if (brut.startsWith(LITTERAL)) {
    return { ok: true, part: { name, value: brut.slice(LITTERAL.length) } };
  }

  if (brut.startsWith('@') || brut.startsWith('<')) {
    const televerse = brut.startsWith('@');
    // `;type=` et `;filename=` suivent le chemin, séparés par `;`.
    const morceaux = brut.slice(1).split(';');
    const chemin = morceaux[0];
    let type: string | undefined;
    let nomFichier = chemin.split('/').pop() ?? chemin;
    for (const opt of morceaux.slice(1)) {
      const t = /^type=(.+)$/.exec(opt.trim());
      if (t) type = t[1];
      const f = /^filename=(.+)$/.exec(opt.trim());
      if (f) nomFichier = f[1];
    }
    const contenu = lire(chemin);
    if (contenu === null) {
      return {
        ok: false, code: 26,
        message: `curl: (26) Failed to open/read local data from file/application`,
      };
    }
    if (!televerse) return { ok: true, part: { name, value: contenu } };
    return {
      ok: true,
      part: {
        name,
        value: contenu,
        filename: nomFichier,
        contentType: type ?? contentTypeForPath(chemin),
      },
    };
  }

  return { ok: true, part: { name, value: brut } };
}

export function buildMultipart(
  specs: readonly string[], lire: (chemin: string) => string | null,
): FormBuild {
  const parts: FormPart[] = [];
  for (const spec of specs) {
    const r = parseFormPart(spec, lire);
    if (r.ok === false) return { ok: false, message: r.message, code: r.code };
    parts.push(r.part);
  }
  const boundary = makeBoundary();
  const lignes: string[] = [];
  for (const p of parts) {
    lignes.push(`--${boundary}`);
    lignes.push(p.filename === undefined
      ? `Content-Disposition: form-data; name="${p.name}"`
      : `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"`);
    if (p.contentType) lignes.push(`Content-Type: ${p.contentType}`);
    lignes.push('');
    lignes.push(p.value);
  }
  lignes.push(`--${boundary}--`);
  return {
    ok: true,
    boundary,
    // RFC 7578 §4.1 renvoie à RFC 2046 : les lignes d'un corps
    // multipart se terminent par CRLF, pas par LF. Un analyseur strict
    // rejette l'autre.
    body: `${lignes.join('\r\n')}\r\n`,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
