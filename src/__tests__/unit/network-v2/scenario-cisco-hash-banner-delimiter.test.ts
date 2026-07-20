/**
 * Scénario 2 — Le caractère # : délimiteur de bannière vs caractère de
 * prompt.
 *
 * Trois rôles : # du prompt privilégié, # délimiteur de `banner motd #`,
 * # dans le CONTENU d'une bannière (piège : tronque à la première
 * occurrence du délimiteur, fidèle à Cisco IOS). `show running-config`
 * représente toujours le délimiteur par ^C, quel que soit le caractère
 * saisi.
 *
 * Adaptation assumée : le pseudocode parse_banner_command du scénario
 * suppose un délimiteur d'un seul caractère ; la sortie réelle d'IOS
 * utilise la notation ^C (deux caractères affichés pour Ctrl-C), donc le
 * parseur transcrit ici traite « ^C » comme un jeton délimiteur à part
 * entière — sans quoi il ne saurait pas relire la propre sortie d'IOS.
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

// ─── parse_banner_command du scénario, transcrit (délimiteur ^C géré) ─

function parseBannerCommand(line: string, subsequentLines: string[]): {
  type: string; delimiter: string; content: string; inline: boolean;
} {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) throw new Error(`Bannière mal formée: ${line}`);
  const bannerType = parts[1];
  const rest = line.trim().slice(line.trim().indexOf(bannerType) + bannerType.length + 1);
  const delimiter = rest.startsWith('^C') ? '^C' : rest[0];

  if (rest.length > delimiter.length && rest.endsWith(delimiter)) {
    return {
      type: bannerType, delimiter,
      content: rest.slice(delimiter.length, -delimiter.length),
      inline: true,
    };
  }
  const contentLines: string[] = [];
  for (const next of subsequentLines) {
    if (next.trim() === delimiter) break;
    if (next.endsWith(delimiter)) {
      contentLines.push(next.slice(0, -delimiter.length));
      break;
    }
    contentLines.push(next);
  }
  return { type: bannerType, delimiter, content: contentLines.join('\n'), inline: false };
}

describe('Scénario 2 — # : délimiteur de bannière vs caractère de prompt', () => {
  describe('rôle 1 — # dans le prompt = mode privilégié', () => {
    it('Router#, Router(config)#, Router(config-if)# selon le mode', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      expect(r.getPrompt()).toBe('Router#');
      await r.executeCommand('configure terminal');
      expect(r.getPrompt()).toBe('Router(config)#');
      await r.executeCommand('interface GigabitEthernet0/0');
      expect(r.getPrompt()).toBe('Router(config-if)#');
      await r.executeCommand('end');
      expect(r.getPrompt()).toBe('Router#');
    });
  });

  describe('rôle 2 — # comme délimiteur de bannière multi-lignes', () => {
    it('banner motd # ouvre la bannière ; # seul sur une ligne la ferme', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const open = await r.executeCommand('banner motd #');
      expect(open).toMatch(/End with the character/);
      await r.executeCommand('Entrez votre message ici');
      await r.executeCommand('Ce message peut contenir des retours à la ligne');
      await r.executeCommand('#');
      await r.executeCommand('end');

      expect(r.getBanner('motd')).toBe(
        'Entrez votre message ici\nCe message peut contenir des retours à la ligne',
      );
    });

    it('bannière inline : banner motd #Contenu inline# fonctionne aussi', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #Contenu inline#');
      await r.executeCommand('end');
      expect(r.getBanner('motd')).toBe('Contenu inline');
    });

    it('bannière vide : banner motd ## et banner motd $$', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #x#');
      await r.executeCommand('banner motd ##');
      expect(r.getBanner('motd')).toBe('');
      await r.executeCommand('banner motd $y$');
      await r.executeCommand('banner motd $$');
      expect(r.getBanner('motd')).toBe('');
      await r.executeCommand('end');
    });
  });

  describe('rôle 3 — # dans le CONTENU : tronqué à la première occurrence (piège IOS)', () => {
    it('le # du contenu ferme prématurément la bannière ; les lignes suivantes deviennent des commandes invalides', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #');
      // Le # de "#INC-001" est interprété comme FIN de la bannière.
      await r.executeCommand('Ticket: #INC-001');
      // La bannière est fermée : le contenu s'arrête AVANT le #.
      expect(r.getBanner('motd')).toBe('Ticket: ');

      // "Suite du message" n'est PAS dans la bannière : c'est une
      // commande inconnue en mode config.
      const suite = await r.executeCommand('Suite du message');
      expect(suite).toContain("% Invalid input detected at '^' marker.");
      // Le # final aussi : IOS le voit comme une commande inconnue.
      const closing = await r.executeCommand('#');
      expect(closing).toContain("% Invalid input detected at '^' marker.");
      await r.executeCommand('end');
    });

    it('bonne pratique : délimiteur $ absent du contenu → le # du ticket est préservé', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      await r.executeCommand('Bienvenue sur SW-MANDENG-01');
      await r.executeCommand('Référence ticket: #INC-2025-001');
      await r.executeCommand('Contact: admin@mandeng.lan');
      await r.executeCommand('$');
      await r.executeCommand('end');

      expect(r.getBanner('motd')).toBe(
        'Bienvenue sur SW-MANDENG-01\nRéférence ticket: #INC-2025-001\nContact: admin@mandeng.lan',
      );
    });

    it('test de robustesse — délimiteur $ avec # multiples dans le contenu', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      await r.executeCommand('Bienvenue sur SW-MANDENG-01');
      await r.executeCommand('Ticket ref: #INC-2025-001');
      await r.executeCommand('Status: OK #confirmed');
      await r.executeCommand('$');
      await r.executeCommand('end');
      expect(r.getBanner('motd')).toBe(
        'Bienvenue sur SW-MANDENG-01\nTicket ref: #INC-2025-001\nStatus: OK #confirmed',
      );
    });
  });

  describe('représentation dans show running-config : toujours ^C', () => {
    it('saisie avec # → show run affiche banner motd ^C … ^C', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #');
      await r.executeCommand('Message de bienvenue');
      await r.executeCommand('Réseau Mandeng');
      await r.executeCommand('#');
      await r.executeCommand('end');

      const run = await r.executeCommand('show running-config');
      expect(run).toContain('banner motd ^C\nMessage de bienvenue\nRéseau Mandeng\n^C');
      // Le délimiteur # saisi n'apparaît nulle part dans la représentation.
      expect(run).not.toMatch(/banner motd #/);
    });

    it('le remplacement par ^C vaut pour tout délimiteur saisi ($, %, #)', async () => {
      for (const delim of ['#', '$', '%']) {
        const r = new CiscoRouter('Router');
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand(`banner motd ${delim}Bienvenue Mandeng${delim}`);
        await r.executeCommand('end');
        const run = await r.executeCommand('show running-config');
        expect(run).toContain('banner motd ^CBienvenue Mandeng^C');
      }
    });

    it('show running-config | section banner retourne le bloc bannière complet', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #');
      await r.executeCommand('Message de bienvenue Mandeng');
      await r.executeCommand('Site de Douala');
      await r.executeCommand('#');
      await r.executeCommand('banner login #Authentification requise#');
      await r.executeCommand('end');

      const out = await r.executeCommand('show running-config | section banner');
      expect(out).toContain('banner motd ^C\nMessage de bienvenue Mandeng\nSite de Douala\n^C');
      expect(out).toContain('banner login ^CAuthentification requise^C');
    });

    it('le simulateur accepte ^C comme délimiteur : la sortie de show run se recolle telle quelle', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $');
      await r.executeCommand('Message de bienvenue');
      await r.executeCommand('$');
      await r.executeCommand('end');

      const section = await r.executeCommand('show running-config | section banner');
      const bannerLines = section.split('\n').filter((l) => l !== '!');

      // Efface, puis recolle la sortie show run ligne à ligne.
      await r.executeCommand('configure terminal');
      await r.executeCommand('no banner motd');
      for (const line of bannerLines) {
        await r.executeCommand(line);
      }
      await r.executeCommand('end');
      expect(r.getBanner('motd')).toBe('Message de bienvenue');
    });
  });

  describe('parse_banner_command (règles de parsing du scénario)', () => {
    it('extrait délimiteur et contenu depuis la sortie show run (inline et multi-lignes)', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #');
      await r.executeCommand('ligne un');
      await r.executeCommand('ligne deux');
      await r.executeCommand('#');
      await r.executeCommand('end');

      const section = await r.executeCommand('show running-config | section banner');
      const lines = section.split('\n');
      const headerIdx = lines.findIndex((l) => l.startsWith('banner motd'));
      const parsed = parseBannerCommand(lines[headerIdx], lines.slice(headerIdx + 1));
      expect(parsed.type).toBe('motd');
      expect(parsed.delimiter).toBe('^C');
      expect(parsed.inline).toBe(false);
      expect(parsed.content).toBe('ligne un\nligne deux');
      expect(parsed.content).toBe(r.getBanner('motd'));
    });

    it('cas inline : banner motd ^Ctexte^C reparsé donne le même contenu que le stockage', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd $Bienvenue$');
      await r.executeCommand('end');
      const section = await r.executeCommand('show running-config | section banner');
      const header = section.split('\n').find((l) => l.startsWith('banner motd'))!;
      const parsed = parseBannerCommand(header, []);
      expect(parsed.inline).toBe(true);
      expect(parsed.delimiter).toBe('^C');
      expect(parsed.content).toBe('Bienvenue');
    });
  });

  describe('critère de réussite', () => {
    it('premier caractère après le type = délimiteur, quel qu\'il soit ; ^C dans show run ; troncature fidèle', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      // Délimiteur arbitraire (lettre Z impossible ? non : tout sauf espace)
      await r.executeCommand('banner motd =Avertissement Mandeng=');
      expect(r.getBanner('motd')).toBe('Avertissement Mandeng');

      // ^C systématique dans show run
      await r.executeCommand('do show running-config | include banner');
      const run = await r.executeCommand('do show running-config');
      expect(run).toContain('banner motd ^CAvertissement Mandeng^C');

      // Troncature à la première occurrence du délimiteur dans le contenu
      await r.executeCommand('banner motd #');
      await r.executeCommand('Avant#Apres');
      expect(r.getBanner('motd')).toBe('Avant');
      await r.executeCommand('end');
    });
  });
});
