/**
 * Scénario 9 — Bannières Cisco avec délimiteur ^C dans show run :
 * copy-paste et reproduction.
 *
 * Le délimiteur affiché par `show running-config` est TOUJOURS ^C — la
 * représentation visuelle du caractère Ctrl-C (ASCII 0x03) — quel que
 * soit le délimiteur réellement saisi lors de la configuration. Le
 * simulateur doit accepter les DEUX représentations en entrée : le vrai
 * caractère \x03 (flux SSH/copy-paste binaire) et la séquence visuelle
 * « ^C » (deux caractères, re-collage d'un show run affiché). Un \x03
 * isolé HORS saisie de bannière reste une interruption (Ctrl-C), fidèle
 * à IOS. Côté bash, $'\x03' produit le vrai octet 0x03 là où '^C'
 * littéral reste deux caractères.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const CTRL_C_CHAR = '\x03';   // caractère réel (1 octet)
const CTRL_C_DISPLAY = '^C';  // représentation visuelle (2 caractères)

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function configureBanner(r: CiscoRouter, delimiter: string, lines: string[]): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand(`banner motd ${delimiter}`);
  for (const l of lines) await r.executeCommand(l);
  await r.executeCommand(delimiter);
  await r.executeCommand('end');
}

describe('Scénario 9 — délimiteur ^C dans show running-config', () => {
  describe('représentation dans show run : toujours ^C, quel que soit le délimiteur saisi', () => {
    it('bannière saisie avec $ → show run réaffiche banner motd ^C … ^C', async () => {
      const r = new CiscoRouter('SW-MANDENG-01');
      await configureBanner(r, '$', ['Bienvenue sur SW-MANDENG-01']);
      const out = await r.executeCommand('show running-config | section banner');
      expect(out).toContain(['banner motd ^C', 'Bienvenue sur SW-MANDENG-01', '^C'].join('\n'));
      // Le délimiteur d'origine ($) ne doit apparaître nulle part.
      expect(out).not.toContain('banner motd $');
    });

    it('bannière saisie avec # → show run réaffiche aussi ^C (jamais le # saisi)', async () => {
      const r = new CiscoRouter('SW-MANDENG-01');
      await configureBanner(r, '#', ['Acces restreint']);
      const out = await r.executeCommand('show running-config | section banner');
      expect(out).toContain(['banner motd ^C', 'Acces restreint', '^C'].join('\n'));
      expect(out).not.toMatch(/banner motd #/);
    });
  });

  describe('le vrai caractère \\x03 est accepté comme délimiteur', () => {
    it('banner motd \\x03 … ligne \\x03 → bannière identique à la saisie $', async () => {
      const r = new CiscoRouter('SW-MANDENG-01');
      await configureBanner(r, CTRL_C_CHAR, ['Bienvenue sur SW-MANDENG-01']);
      expect(r.getBanner('motd')).toBe('Bienvenue sur SW-MANDENG-01');
      const out = await r.executeCommand('show running-config | section banner');
      expect(out).toContain(['banner motd ^C', 'Bienvenue sur SW-MANDENG-01', '^C'].join('\n'));
    });
  });

  describe('la séquence visuelle ^C (2 caractères) est acceptée en re-collage', () => {
    it('re-coller la sortie de show run (banner motd ^C … ^C) reproduit la même bannière', async () => {
      const rA = new CiscoRouter('RA');
      await configureBanner(rA, '$', ['Bienvenue sur SW-MANDENG-01', 'Acces reserve']);
      const sectionA = await rA.executeCommand('show running-config | section banner');

      // Re-collage ligne à ligne de la sortie show run sur un second routeur :
      // le délimiteur affiché ^C (deux caractères) doit être accepté.
      const rB = new CiscoRouter('RB');
      await rB.executeCommand('enable');
      await rB.executeCommand('configure terminal');
      for (const line of sectionA.split('\n')) {
        if (line.trim() === '!' || line.trim() === '') continue;
        await rB.executeCommand(line);
      }
      await rB.executeCommand('end');

      expect(rB.getBanner('motd')).toBe(rA.getBanner('motd'));
      expect(rB.getBanner('motd')).toBe('Bienvenue sur SW-MANDENG-01\nAcces reserve');
    });
  });

  describe('piège copy-paste : \\x03 isolé hors bannière = interruption', () => {
    it('en mode config (hors saisie de bannière), une ligne \\x03 ramène au mode privilégié', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      expect(r.getPrompt()).toBe('Router(config)#');
      await r.executeCommand(CTRL_C_CHAR);
      expect(r.getPrompt()).toBe('Router#');
    });
  });

  describe('côté bash : $\'\\x03\' vs les deux caractères ^C', () => {
    it("CTRL_C=$'\\x03' produit UN caractère ; '^C' littéral en produit DEUX", async () => {
      const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
      pc.powerOn();
      const real = await pc.executeCommand("CTRL_C=$'\\x03'; echo ${#CTRL_C}");
      expect(real.trim()).toBe('1');
      const visual = await pc.executeCommand("VISUAL='^C'; echo ${#VISUAL}");
      expect(visual.trim()).toBe('2');
    });

    it("dans une chaîne bash ordinaire, ^C reste les deux caractères ^ et C (pas 0x03)", async () => {
      const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
      pc.powerOn();
      // 'banner motd ^C' = 14 caractères (^C compte pour 2) ; si ^C avait été
      // interprété comme l'octet 0x03, la chaîne en ferait 13.
      const out = await pc.executeCommand("CISCO_CMD='banner motd ^C'; echo ${#CISCO_CMD}");
      expect(out.trim()).toBe('14');
    });
  });

  describe('script de réplication de bannière entre équipements', () => {
    it('extraction (sed/tr du scénario) + ré-application avec $ → bannières identiques', async () => {
      const rA = new CiscoRouter('RA');
      await configureBanner(rA, '$', ['Bienvenue sur SW-MANDENG-01', 'Contact: admin@mandeng.lan']);
      const sectionA = await rA.executeCommand('show running-config | section banner');

      // Transcription du pipeline bash du scénario :
      //   sed '/^banner motd/d' | tr -d '\x03' | sed '/^\^C$/d'
      // On écarte aussi le `!` terminateur de bloc qu'IOS inclut dans
      // `| section` (adaptation assumée, sinon il deviendrait une ligne
      // de la bannière répliquée).
      const bannerContent = sectionA.split('\n')
        .filter((l) => !/^banner motd/.test(l))
        .map((l) => l.replace(/\x03/g, ''))
        .filter((l) => l.trim() !== CTRL_C_DISPLAY)
        .filter((l) => l.trim() !== '!' && l.trim() !== '')
        .join('\n');
      expect(bannerContent).toBe('Bienvenue sur SW-MANDENG-01\nContact: admin@mandeng.lan');

      // Ré-application sur la destination avec le délimiteur safe $.
      const rB = new CiscoRouter('RB');
      await rB.executeCommand('enable');
      await rB.executeCommand('configure terminal');
      await rB.executeCommand('banner motd $');
      for (const line of bannerContent.split('\n')) await rB.executeCommand(line);
      await rB.executeCommand('$');
      await rB.executeCommand('end');

      expect(rB.getBanner('motd')).toBe(rA.getBanner('motd'));
    });
  });
});
