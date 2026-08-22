import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { bootFortiConsole, openFortiConsole } from './fortiConsoleHarness';
import {
  encryptConfig, decryptConfig, isEncryptedConfig, FORTI_BACKUP_MAGIC,
} from '@/network/devices/firewall/vendors/fortios/backup/ConfigEncryption';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (fgt: FortiGate, ...cmds: string[]) => cmds.reduce(
  (chain, cmd) => chain.then(() => fgt.executeCommand(cmd)),
  Promise.resolve(''),
);

function machine(): FortiGate {
  return new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
}

async function politique(fgt: FortiGate, ...extra: string[]): Promise<void> {
  await run(fgt, 'config system password-policy',
    'set status enable', 'set minimum-length 12',
    'set min-upper-case-letter 1', 'set min-number 1',
    'set min-non-alphanumeric 1', ...extra, 'end');
}

describe('la politique de mots de passe REFUSE ce qu\'elle declare refuser', () => {
  it('sans politique, un mot de passe faible passe — c\'est le temoin', async () => {
    const fgt = machine();
    await run(fgt, 'config system admin', 'edit "essai"');

    expect(await fgt.executeCommand('set password "1234"')).toBe('');
  });

  it('la longueur minimale est appliquee, et la refusal la NOMME', async () => {
    const fgt = machine();
    await politique(fgt);
    await run(fgt, 'config system admin', 'edit "essai"');

    const refus = await fgt.executeCommand('set password "Court1!"');

    expect(refus).toMatch(/Command fail|parse error/i);
    expect(refus).toContain('12');
  });

  it('chaque classe de caracteres manquante est nommee', async () => {
    const fgt = machine();
    await politique(fgt);
    await run(fgt, 'config system admin', 'edit "essai"');

    expect(await fgt.executeCommand('set password "minusculesansrien"'))
      .toContain('uppercase');
    expect(await fgt.executeCommand('set password "MinusculeSansRien"'))
      .toContain('digit');
    expect(await fgt.executeCommand('set password "MinusculeSansRien1"'))
      .toContain('non-alphanumeric');
  });

  it('un mot de passe conforme est accepte', async () => {
    const fgt = machine();
    await politique(fgt);
    await run(fgt, 'config system admin', 'edit "essai"');

    expect(await fgt.executeCommand('set password "MotDePasse2026!"')).toBe('');
  });

  it('`apply-to` decide : sans `ipsec-preshared-key`, la cle partagee passe', async () => {
    const fgt = machine();
    await politique(fgt, 'set apply-to admin-password');
    await run(fgt, 'config vpn ipsec phase1-interface', 'edit "T1"');

    expect(await fgt.executeCommand('set psksecret "court"')).toBe('');
  });

  it('`apply-to ipsec-preshared-key` REFUSE une cle partagee faible', async () => {
    const fgt = machine();
    await politique(fgt, 'set apply-to admin-password ipsec-preshared-key');
    await run(fgt, 'config vpn ipsec phase1-interface', 'edit "T1"');

    expect(await fgt.executeCommand('set psksecret "court"'))
      .toMatch(/Command fail|parse error/i);
  });

  it('la politique se relit dans la configuration', async () => {
    const fgt = machine();
    await politique(fgt);

    const conf = await fgt.executeCommand('show system password-policy');

    expect(conf).toContain('set status enable');
    expect(conf).toContain('set minimum-length 12');
  });
});

describe('la banniere de connexion s\'affiche a l\'endroit qu\'elle nomme', () => {
  async function banniere(fgt: FortiGate, quand: 'pre' | 'post'): Promise<void> {
    await run(fgt,
      'config system global', `set ${quand}-login-banner enable`, 'end',
      `config system replacemsg admin "${quand}_admin-disclaimer-text"`,
      'set buffer "ACCES RESERVE AUX PERSONNES AUTORISEES."', 'next', 'end');
  }

  it('la banniere d\'AVANT precede l\'invite de connexion', async () => {
    const fgt = machine();
    await banniere(fgt, 'pre');
    const console_ = await bootFortiConsole(fgt);

    expect(console_.lines.map(l => l.text).join('\n'))
      .toContain('ACCES RESERVE AUX PERSONNES AUTORISEES.');
  });

  it('sans le drapeau, le texte pose ne s\'affiche PAS', async () => {
    const fgt = machine();
    await run(fgt,
      'config system replacemsg admin "pre_admin-disclaimer-text"',
      'set buffer "ACCES RESERVE."', 'next', 'end');
    const console_ = await bootFortiConsole(fgt);

    expect(console_.lines.map(l => l.text).join('\n')).not.toContain('ACCES RESERVE.');
  });

  it('avec le drapeau et SANS texte, rien ne s\'affiche', async () => {
    const fgt = machine();
    await run(fgt, 'config system global', 'set pre-login-banner enable', 'end');
    const console_ = await bootFortiConsole(fgt);

    expect(console_.lines.map(l => l.text).join('\n')).not.toContain('disclaimer');
  });

  it('la banniere d\'APRES ne parait qu\'une fois la connexion acceptee', async () => {
    const fgt = machine();
    await banniere(fgt, 'post');

    const avant = await bootFortiConsole(fgt);
    expect(avant.lines.map(l => l.text).join('\n'))
      .not.toContain('ACCES RESERVE AUX PERSONNES AUTORISEES.');

    const apres = await openFortiConsole(fgt);
    expect(apres.lines.map(l => l.text).join('\n'))
      .toContain('ACCES RESERVE AUX PERSONNES AUTORISEES.');
  });

  it('la configuration rendue porte la CLE sur la ligne `config`, comme FortiOS',
    async () => {
      const fgt = machine();
      await banniere(fgt, 'pre');

      expect(await fgt.executeCommand('show system replacemsg admin'))
        .toContain('config system replacemsg admin "pre_admin-disclaimer-text"');
    });

  it('cette forme se REJOUE — une topologie rechargee garde sa banniere', async () => {
    const source = machine();
    await banniere(source, 'pre');
    const rendu = await source.executeCommand('show');

    const cible = machine();
    for (const ligne of rendu.split('\n')) await cible.executeCommand(ligne.trim());

    expect(cible.getLoginBanners().lines('pre')).toEqual([
      'ACCES RESERVE AUX PERSONNES AUTORISEES.',
    ]);
  });
});

describe('une sauvegarde chiffree l\'est pour de bon', () => {
  it('le texte chiffre ne contient rien du texte clair', () => {
    const chiffre = encryptConfig('config system global\n    set hostname "SECRET"\nend',
      'MotDePasse2026');

    expect(chiffre.startsWith(FORTI_BACKUP_MAGIC)).toBe(true);
    expect(chiffre).not.toContain('hostname');
    expect(chiffre).not.toContain('SECRET');
  });

  it('le bon mot de passe rend le texte a l\'identique', () => {
    const clair = 'config system global\n    set hostname "SECRET"\nend';

    expect(decryptConfig(encryptConfig(clair, 'bon'), 'bon')).toBe(clair);
  });

  it('un mauvais mot de passe rend `null` — l\'etiquette GCM le DETECTE', () => {
    expect(decryptConfig(encryptConfig('config x\nend', 'bon'), 'mauvais')).toBeNull();
  });

  it('un octet retourne est detecte, pas dechiffre de travers', () => {
    const chiffre = encryptConfig('config x\nend', 'bon');
    const lignes = chiffre.split('\n');
    const corps = lignes[1];
    lignes[1] = (corps[0] === 'A' ? 'B' : 'A') + corps.slice(1);

    expect(decryptConfig(lignes.join('\n'), 'bon')).toBeNull();
  });

  it('deux chiffrements du MEME texte different — le vecteur est tire au sort', () => {
    const clair = 'config x\nend';

    expect(encryptConfig(clair, 'bon')).not.toBe(encryptConfig(clair, 'bon'));
  });

  it('un texte clair n\'est pas pris pour un texte chiffre', () => {
    expect(isEncryptedConfig('config system global\nend')).toBe(false);
    expect(decryptConfig('config system global\nend', 'bon')).toBeNull();
  });
});
