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
      if (/\bDrop\(|\bReject\(|verdict\s*=/.test(text)) offenders.push(relative(file));
    }

    expect(offenders).toEqual([]);
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
