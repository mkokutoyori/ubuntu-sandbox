/**
 * Scénario 3 — Bannières multi-lignes avec caractères spéciaux :
 * ^, %, @, accents, pseudo-graphiques.
 *
 * Le contenu d'une bannière est stocké et restitué octet par octet :
 * ^ ordinaire (≠ ^C délimiteur), % (≠ messages d'erreur IOS), @, accents
 * UTF-8, caractères de boîte ╔═║╗╚╝, espaces de début de ligne et lignes
 * vides internes. validate_banner_content du scénario est transcrit ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

// ─── validate_banner_content du scénario, transcrit ────────────────

const PROBLEMATIC_CHARS: Record<number, string> = {
  0x00: 'NULL - terminerait la chaîne',
  0x03: 'Ctrl-C - délimiteur standard show run',
  0x1a: 'Ctrl-Z - retour mode EXEC (fin de config)',
  0x1b: 'ESC - début de séquences ANSI (ignoré sur terminaux série)',
};

interface BannerWarning {
  position?: number;
  char?: string;
  issue: string;
  severity: 'CRITICAL' | 'WARNING' | 'ERROR';
  consequence?: string;
}

function validateBannerContent(content: string, delimiter: string): BannerWarning[] {
  const warnings: BannerWarning[] = [];
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === delimiter) {
      warnings.push({
        position: i,
        issue: `Délimiteur '${delimiter}' dans le contenu`,
        severity: 'CRITICAL',
        consequence: 'Bannière tronquée à cette position',
      });
    }
    const code = char.charCodeAt(0);
    if (code in PROBLEMATIC_CHARS) {
      warnings.push({
        position: i,
        char: JSON.stringify(char),
        issue: PROBLEMATIC_CHARS[code],
        severity: 'WARNING',
      });
    }
  }
  if (delimiter === ' ') {
    warnings.push({ issue: "L'espace ne peut pas être délimiteur", severity: 'ERROR' });
  }
  return warnings;
}

const BOX_BANNER_LINES = [
  '╔═══════════════════════════════════════╗',
  '║  RÉSEAU MANDENG - ACCÈS SÉCURISÉ     ║',
  '║  ─────────────────────────────────── ║',
  '║  Système : SW-MANDENG-01             ║',
  '║  Site    : Douala - Siège            ║',
  '╚═══════════════════════════════════════╝',
];

describe('Scénario 3 — Bannières multi-lignes avec caractères spéciaux', () => {
  describe('caractère ^ (caret) dans le contenu', () => {
    it('^ ordinaire est stocké tel quel, sans confusion avec ^C', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      await r.executeCommand('═══════════════════════════════════════════');
      await r.executeCommand('  AVERTISSEMENT ^ ACCÈS RESTREINT');
      await r.executeCommand('  Niveau de risque : ÉLEVÉ^2');
      await r.executeCommand('  Contact: admin@mandeng.lan');
      await r.executeCommand('═══════════════════════════════════════════');
      await r.executeCommand('$');
      await r.executeCommand('end');

      const banner = r.getBanner('motd');
      expect(banner).toContain('AVERTISSEMENT ^ ACCÈS RESTREINT');
      expect(banner).toContain('Niveau de risque : ÉLEVÉ^2');
      expect(banner).toContain('Contact: admin@mandeng.lan');
    });
  });

  describe('caractère % dans le contenu', () => {
    it('les lignes % de la bannière ne sont pas interprétées comme des erreurs IOS', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner exec $');
      const l1 = await r.executeCommand('% Attention : session enregistrée');
      const l2 = await r.executeCommand('% Durée de session limitée à 30 minutes');
      // Pendant la collecte, ces lignes sont du contenu : aucune erreur.
      expect(l1).toBe('');
      expect(l2).toBe('');
      await r.executeCommand('$');
      await r.executeCommand('end');

      expect(r.getBanner('exec')).toBe(
        '% Attention : session enregistrée\n% Durée de session limitée à 30 minutes',
      );
    });
  });

  describe('pseudo-graphiques et espaces de début de ligne', () => {
    it('les caractères ╔ ═ ║ ╗ ╚ ╝ et les espaces initiaux sont préservés octet par octet', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      for (const line of BOX_BANNER_LINES) {
        await r.executeCommand(line);
      }
      await r.executeCommand('$');
      await r.executeCommand('end');

      expect(r.getBanner('motd')).toBe(BOX_BANNER_LINES.join('\n'));
    });

    it('les lignes vides internes de la bannière sont conservées', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      await r.executeCommand('Ligne 1');
      await r.executeCommand('');
      await r.executeCommand('  Ligne 3 indentée');
      await r.executeCommand('$');
      await r.executeCommand('end');

      expect(r.getBanner('motd')).toBe('Ligne 1\n\n  Ligne 3 indentée');
    });
  });

  describe('reproduction exacte dans show running-config | section banner', () => {
    it('reproduit la bannière à l\'identique : espaces de tête, accents, pseudo-graphiques', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      for (const line of BOX_BANNER_LINES) {
        await r.executeCommand(line);
      }
      await r.executeCommand('$');
      await r.executeCommand('end');

      const section = await r.executeCommand('show running-config | section banner');
      expect(section).toContain(
        ['banner motd ^C', ...BOX_BANNER_LINES, '^C'].join('\n'),
      );
    });

    it('la bannière est aussi restituée telle quelle à la connexion SSH (getSshBanner)', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      for (const line of BOX_BANNER_LINES) {
        await r.executeCommand(line);
      }
      await r.executeCommand('  Authentification requise.');
      await r.executeCommand('  Contact: admin@mandeng.lan');
      await r.executeCommand('$');
      await r.executeCommand('end');

      // Le MOTD alimente la bannière affichée lors des connexions.
      expect(r.getSshBanner()).toBe(
        [...BOX_BANNER_LINES, '  Authentification requise.', '  Contact: admin@mandeng.lan'].join('\n'),
      );
    });
  });

  describe('validate_banner_content (règles du scénario)', () => {
    it('détecte le délimiteur présent dans le contenu comme CRITICAL avec position', () => {
      const warnings = validateBannerContent('Ticket: #INC-001', '#');
      const critical = warnings.filter((w) => w.severity === 'CRITICAL');
      expect(critical.length).toBe(1);
      expect(critical[0].position).toBe('Ticket: '.length);
      expect(critical[0].consequence).toBe('Bannière tronquée à cette position');
    });

    it('détecte les caractères de contrôle problématiques (Ctrl-C, Ctrl-Z, ESC, NULL)', () => {
      const warnings = validateBannerContent('abc\x03def\x1a\x1b\x00', '#');
      const issues = warnings.filter((w) => w.severity === 'WARNING').map((w) => w.issue);
      expect(issues).toContain('Ctrl-C - délimiteur standard show run');
      expect(issues).toContain('Ctrl-Z - retour mode EXEC (fin de config)');
      expect(issues).toContain('ESC - début de séquences ANSI (ignoré sur terminaux série)');
      expect(issues).toContain('NULL - terminerait la chaîne');
    });

    it("refuse l'espace comme délimiteur", () => {
      const warnings = validateBannerContent('contenu', ' ');
      expect(warnings.some((w) => w.severity === 'ERROR')).toBe(true);
    });

    it('le simulateur refuse aussi l\'espace comme délimiteur à la saisie', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      // `banner motd ` sans délimiteur : commande incomplète, pas de
      // bannière ouverte.
      const out = await r.executeCommand('banner motd ');
      expect(out).toMatch(/% (Incomplete command|Invalid input)/);
      // Le shell n'est PAS entré en mode collecte : la ligne suivante est
      // une commande normale.
      expect(await r.executeCommand('hostname RTEST')).toBe('');
      expect(r.getPrompt()).toBe('RTEST(config)#');
      await r.executeCommand('end');
    });
  });

  describe('critère de réussite', () => {
    it('^, %, @ restitués tels quels ; ASCII-art octet par octet ; section banner identique', async () => {
      const content = [
        '╔═══════════════════════════════════════╗',
        '║  ACCÈS ^ RESTREINT — 100% surveillé  ║',
        '║  Contact: admin@mandeng.lan          ║',
        '╚═══════════════════════════════════════╝',
      ];
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      for (const line of content) await r.executeCommand(line);
      await r.executeCommand('$');
      await r.executeCommand('end');

      expect(r.getBanner('motd')).toBe(content.join('\n'));
      const section = await r.executeCommand('show running-config | section banner');
      expect(section).toContain(['banner motd ^C', ...content, '^C'].join('\n'));
    });
  });
});
