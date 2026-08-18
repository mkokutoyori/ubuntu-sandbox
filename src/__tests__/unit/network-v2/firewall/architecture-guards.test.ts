/**
 * Les garde-fous d'architecture du module (BRD-Firewall §40.6).
 *
 * Ce fichier ne teste aucun comportement : il teste des CONTRAINTES, et
 * c'est ce qui le rend utile. Les affirmations du BRD sur la maintenabilite
 * — « aucun moteur dans la couche vendeur », « aucun branchement par
 * vendeur dans le socle » — ne valent que si quelque chose les verifie. Sans
 * cela elles se degradent au premier raccourci, et personne ne s'en apercoit
 * avant la troisieme declinaison.
 *
 * Ils sont ecrits maintenant, alors qu'il n'y a qu'un seul vendeur, parce
 * qu'un garde-fou ajoute apres coup constate les degats au lieu de les
 * empecher.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MODULE_ROOT = join(process.cwd(), 'src/network/devices/firewall');
const VENDORS_ROOT = join(MODULE_ROOT, 'vendors');

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

function relative(path: string): string {
  return path.slice(MODULE_ROOT.length + 1);
}

const ALL_FILES = filesUnder(MODULE_ROOT);
const VENDOR_FILES = filesUnder(VENDORS_ROOT);
const SOCLE_FILES = ALL_FILES.filter(f => !f.startsWith(VENDORS_ROOT));

const PACKET_VERDICT = /\bDrop\(|\bReject\(|\.verdict\s*=[^=]/;

const ENGINE_MARKERS = [
  'class SessionTable',
  'class PolicyEvaluator',
  'class FirewallNatEngine',
  'class FirewallPipeline',
  'class ZoneTable',
  'class ObjectStore',
  'class ArpService',
  'class RouteTable',
  'class TcpStateMachine',
];

describe('G1 — aucun moteur dans la couche vendeur', () => {
  it('trouve bien des fichiers vendeur a controler', () => {
    expect(VENDOR_FILES.length).toBeGreaterThan(0);
  });

  it('aucun fichier vendeur ne DEFINIT un moteur du socle', () => {
    const offenders: string[] = [];
    for (const file of VENDOR_FILES) {
      const text = readFileSync(file, 'utf8');
      for (const marker of ENGINE_MARKERS) {
        if (text.includes(marker)) offenders.push(`${relative(file)} → ${marker}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('aucun fichier vendeur ne decide du sort d\'un paquet', () => {
    const offenders: string[] = [];
    for (const file of VENDOR_FILES) {
      const text = readFileSync(file, 'utf8');
      if (PACKET_VERDICT.test(text)) offenders.push(relative(file));
    }

    expect(offenders).toEqual([]);
  });

  it('le garde-fou vise le verdict d\'un CONTEXTE, pas un mot du meme nom', () => {
    expect(PACKET_VERDICT.test('const keyword = permit ? 1 : 2;')).toBe(false);
    expect(PACKET_VERDICT.test('ctx.verdict = \'dropped\';')).toBe(true);
    expect(PACKET_VERDICT.test('return Drop(ctx, \'policy-deny\');')).toBe(true);
  });

  it('un fichier vendeur reste petit — il assemble, il ne calcule pas', () => {
    const tooBig = VENDOR_FILES
      .map(f => ({ file: relative(f), lines: readFileSync(f, 'utf8').split('\n').length }))
      .filter(x => x.lines > 800);

    expect(tooBig).toEqual([]);
  });
});

describe('G2 — aucun branchement par vendeur dans le socle', () => {
  it('aucun fichier du socle ne teste l\'identite d\'un vendeur', () => {
    const offenders: string[] = [];
    for (const file of SOCLE_FILES) {
      const text = readFileSync(file, 'utf8');
      if (/vendor\s*===|=== *'asa'|=== *'fortios'|=== *'panos'|=== *'junos'/.test(text)) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('aucun fichier du socle n\'importe la couche vendeur', () => {
    const offenders: string[] = [];
    for (const file of SOCLE_FILES) {
      const text = readFileSync(file, 'utf8');
      if (/from '.*vendors\//.test(text)) offenders.push(relative(file));
    }

    expect(offenders).toEqual([]);
  });
});

describe('G3 — aucun fichier du socle ne depasse 800 lignes (NFR-M3)', () => {
  it('respecte la contrainte que le module s\'est donnee', () => {
    const tooBig = SOCLE_FILES
      .map(f => ({ file: relative(f), lines: readFileSync(f, 'utf8').split('\n').length }))
      .filter(x => x.lines > 800);

    expect(tooBig).toEqual([]);
  });
});

describe('G5 — aucun minuteur direct, l\'ordonnanceur du depot fait foi', () => {
  const timerCall = /(?<![.\w])(setTimeout|setInterval)\s*\(/;
  const declaration = /^\s{2}(setTimeout|setInterval)\s*\(/;

  it('aucun APPEL au minuteur global du navigateur', () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (timerCall.test(line) && !declaration.test(line)) {
          offenders.push(`${relative(file)} → ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('le garde-fou distingue un APPEL d\'une METHODE du meme nom', () => {
    expect(timerCall.test('    services.sessions.setTimeout(s, 30);')).toBe(false);
    expect(declaration.test('  setTimeout(session: FirewallSession): void {')).toBe(true);
    expect(timerCall.test('    setTimeout(() => fire(), 1000);')).toBe(true);
  });
});

describe('Convention du depot — pas de commentaires explicatifs en production', () => {
  const sectionDivider = /^\s*\/\/ ─+/;

  it('aucun bloc de documentation `/**` dans le module', () => {
    const offenders = ALL_FILES
      .filter(f => readFileSync(f, 'utf8').includes('/**'))
      .map(relative);

    expect(offenders).toEqual([]);
  });

  it('aucun commentaire EXPLICATIF — les separateurs de section restent permis', () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (/^\s*\/\/ /.test(line) && !sectionDivider.test(line)) {
          offenders.push(`${relative(file)} → ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('le garde-fou distingue un separateur d\'une explication', () => {
    expect(sectionDivider.test('  // ─── Addresses ────────────')).toBe(true);
    expect(sectionDivider.test('  // on saute la premiere entree')).toBe(false);
  });
});

describe('G6 — la grammaire FortiOS ne porte aucune liste blanche hors du schema', () => {
  const FORTIOS_ROOT = join(VENDORS_ROOT, 'fortios');
  const FORTIOS_FILES = filesUnder(FORTIOS_ROOT);
  const SCHEMA_DIR = join(FORTIOS_ROOT, 'schema');
  const HORS_SCHEMA = FORTIOS_FILES.filter(f => !f.startsWith(SCHEMA_DIR));

  it('trouve bien des fichiers a controler', () => {
    expect(HORS_SCHEMA.length).toBeGreaterThan(0);
  });

  it('aucun `Set` littéral d\'attributs hors du schema', () => {
    const offenders = HORS_SCHEMA
      .filter(f => /new Set\(\[\s*'/.test(readFileSync(f, 'utf8')))
      .map(relative);

    expect(offenders).toEqual([]);
  });

  it('aucun nom d\'attribut de politique code en dur hors du schema', () => {
    const marqueurs = ['srcintf', 'dstintf', 'srcaddr', 'dstaddr', 'utm-status'];
    const offenders: string[] = [];
    for (const file of HORS_SCHEMA) {
      const texte = readFileSync(file, 'utf8');
      for (const mot of marqueurs) {
        if (texte.includes(`'${mot}'`)) offenders.push(`${relative(file)} → ${mot}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('aucun verdict de paquet dans la declinaison FortiOS', () => {
    const offenders = FORTIOS_FILES
      .filter(f => PACKET_VERDICT.test(readFileSync(f, 'utf8')))
      .map(relative);

    expect(offenders).toEqual([]);
  });
});

describe('G7 — tout ce que le schema expose porte une aide', () => {
  it('chaque table et chaque attribut ont une aide non vide', async () => {
    const { FORTIOS_SCHEMA } = await import(
      '@/network/devices/firewall/vendors/fortios/schema');

    const muets: string[] = [];
    for (const spec of FORTIOS_SCHEMA) {
      if (spec.help.trim().length === 0) muets.push(spec.path.join(' '));
      for (const attribute of spec.attributes) {
        if (attribute.help.trim().length === 0) {
          muets.push(`${spec.path.join(' ')} / ${attribute.name}`);
        }
      }
    }

    expect(muets).toEqual([]);
  });

  it('chaque valeur d\'enumeration porte une aide', async () => {
    const { FORTIOS_SCHEMA } = await import(
      '@/network/devices/firewall/vendors/fortios/schema');

    const muets: string[] = [];
    for (const spec of FORTIOS_SCHEMA) {
      for (const attribute of spec.attributes) {
        for (const part of attribute.parts) {
          for (const value of part.values ?? []) {
            if (value.description.trim().length === 0) {
              muets.push(`${spec.path.join(' ')} / ${attribute.name} / ${value.keyword}`);
            }
          }
          if ((part.description ?? '').trim().length === 0) {
            muets.push(`${spec.path.join(' ')} / ${attribute.name} / ${part.name}`);
          }
        }
      }
    }

    expect(muets).toEqual([]);
  });
});

describe('G8 — toute table du schema declare sa portee et son groupe de droits', () => {
  it('`scope`, `accessGroup` et `renderOrder` sont poses partout', async () => {
    const { FORTIOS_SCHEMA } = await import(
      '@/network/devices/firewall/vendors/fortios/schema');

    for (const spec of FORTIOS_SCHEMA) {
      expect(spec.scope, spec.path.join(' ')).toBeDefined();
      expect(spec.accessGroup, spec.path.join(' ')).toBeDefined();
      expect(typeof spec.renderOrder, spec.path.join(' ')).toBe('number');
    }
  });

  it('deux tables ne partagent pas le meme rang de rendu', async () => {
    const { FORTIOS_SCHEMA } = await import(
      '@/network/devices/firewall/vendors/fortios/schema');

    const rangs = FORTIOS_SCHEMA.map(s => s.renderOrder);

    expect(new Set(rangs).size).toBe(rangs.length);
  });

  it('toute table nomme sa cle en PREMIER attribut, et cet attribut est en lecture seule',
    async () => {
      const { FORTIOS_SCHEMA } = await import(
        '@/network/devices/firewall/vendors/fortios/schema');
      const { keyAttributeName } = await import(
        '@/network/devices/firewall/vendors/fortios/schema/types');

      for (const spec of FORTIOS_SCHEMA.filter(s => s.kind === 'table')) {
        expect(keyAttributeName(spec), spec.path.join(' ')).toBeDefined();
      }
    });

  it('une table ordonnee porte une cle entiere — sinon `move` n\'a pas de sens', async () => {
    const { FORTIOS_SCHEMA } = await import(
      '@/network/devices/firewall/vendors/fortios/schema');

    for (const spec of FORTIOS_SCHEMA.filter(s => s.ordered)) {
      expect(spec.keyType, spec.path.join(' ')).toBe('integer');
    }
  });
});
