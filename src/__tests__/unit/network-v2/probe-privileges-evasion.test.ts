/**
 * L'autorisation mise a l'epreuve : evasion, escalade, concurrence.
 *
 * Ecrite A L'AVEUGLE, comme la sonde multinationale : les assertions
 * decrivent ce qu'un vrai IOS fait, sans avoir ete ajustees sur ce que
 * le simulateur rend aujourd'hui.
 *
 * Un mecanisme de securite ne se juge pas sur son cas nominal — celui-la
 * est deja mesure ailleurs — mais sur ce qu'il SURVIT. Ce fichier
 * n'essaie donc pas d'utiliser la delegation correctement : il essaie de
 * la contourner, par les chemins que quelqu'un emprunterait vraiment.
 *
 * 1. LA SURFACE D'ECRITURE. Une regle qui porte sur le texte tape plutot
 *    que sur la commande RESOLUE se contourne en trois secondes :
 *    `sh run` au lieu de `show running-config`, des majuscules, deux
 *    espaces. C'est le premier endroit ou regarder.
 * 2. LES CHEMINS DETOURNES. `do`, les alias, `copy` : trois facons
 *    d'atteindre une commande sans la taper la ou on l'attend.
 * 3. LA CONCURRENCE. Plusieurs operateurs a des niveaux differents sur
 *    la meme machine au meme instant — le niveau de l'un ne doit pas
 *    fuir dans la session de l'autre, et une regle posee par l'un doit
 *    valoir pour l'autre, puisqu'elle appartient a l'EQUIPEMENT.
 * 4. LA REVOCATION EN COURS DE SESSION. Retirer un droit a quelqu'un qui
 *    est deja connecte : c'est le seul moment ou la revocation compte.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const REFUS = "% Invalid input detected at '^' marker.";

/**
 * Un routeur ou le niveau 7 a recu EXACTEMENT trois choses, et rien
 * d'autre. Tout ce que la sonde tente ensuite doit rester dehors.
 */
async function cible(): Promise<CiscoRouter> {
  const r = new CiscoRouter('CIBLE', 0, 0);
  r.powerOn();
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname CIBLE');
  await r.executeCommand('aaa new-model');
  await r.executeCommand('enable secret Coffre15');
  await r.executeCommand('username tech privilege 7 secret Tech7');
  await r.executeCommand('username chef privilege 15 secret Chef15');
  await r.executeCommand('username visiteur privilege 1 secret Visit1');
  await r.executeCommand('privilege exec level 7 show ip interface brief');
  await r.executeCommand('privilege exec level 7 configure terminal');
  await r.executeCommand('privilege configure level 7 interface');
  await r.executeCommand('privilege interface level 7 description');
  await r.executeCommand('end');
  await r.executeCommand('disable');
  return r;
}

describe('EVASION — la regle porte sur la commande RESOLUE, pas sur le texte tape', () => {
  it('une abreviation ne contourne pas le niveau', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
    expect(await r.executeCommand('sh run')).toContain(REFUS);
    expect(await r.executeCommand('sho runn')).toContain(REFUS);
    expect(await r.executeCommand('sh ru')).toContain(REFUS);
  }, 30_000);

  it('les majuscules ne contournent pas le niveau', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    expect(await r.executeCommand('SHOW RUNNING-CONFIG')).toContain(REFUS);
    expect(await r.executeCommand('Show Running-Config')).toContain(REFUS);
  }, 30_000);

  it('les espaces surnumeraires ne contournent pas le niveau', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    expect(await r.executeCommand('show    running-config')).toContain(REFUS);
    expect(await r.executeCommand('  show running-config  ')).toContain(REFUS);
  }, 30_000);

  it('une abreviation d\'une commande ACCORDEE fonctionne, elle', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    expect(await r.executeCommand('sh ip int br')).not.toContain(REFUS);
    expect(await r.executeCommand('sh ip int br')).toContain('Interface');
  }, 30_000);
});

describe('EVASION — les chemins detournes', () => {
  it('`do` depuis la configuration n\'eleve pas le niveau', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('do show running-config')).toContain(REFUS);
    expect(await r.executeCommand('do reload')).toContain(REFUS);
    expect(await r.executeCommand('do write memory')).toContain(REFUS);
  }, 30_000);

  it('`do` d\'une commande accordee marche, lui', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('do show ip interface brief')).not.toContain(REFUS);
  }, 30_000);

  it('un alias ne fait pas passer une commande hors de portee', async () => {
    const r = await cible();
    await r.loginAs('chef', 'Chef15');
    await r.executeCommand('configure terminal');
    await r.executeCommand('alias exec sesame show running-config');
    await r.executeCommand('end');

    await r.loginAs('tech', 'Tech7');
    expect(await r.executeCommand('sesame')).toContain(REFUS);
  }, 30_000);

  it('la sortie d\'une configuration ne laisse pas le mode privilegie', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('end');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 7');
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
  }, 30_000);

  it('on ne se donne pas un droit qu\'on n\'a pas', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('privilege exec level 7 show running-config')).toContain(REFUS);
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
  }, 30_000);

  it('un visiteur de niveau 1 ne monte pas par le mot de passe d\'un autre', async () => {
    const r = await cible();
    await r.loginAs('visiteur', 'Visit1');
    expect(await r.executeCommand('enable', { passwordInput: 'Tech7' }))
      .toContain('% Bad secrets');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 1');
    expect(await r.executeCommand('enable 7', { passwordInput: 'Visit1' }))
      .toContain('% Bad secrets');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 1');
  }, 30_000);
});

describe('CONCURRENCE — deux operateurs, deux niveaux, une machine', () => {
  it('le niveau de l\'un ne fuit pas dans la session de l\'autre', async () => {
    const r = await cible();
    const a = r.openVtySession();
    const b = r.openVtySession();

    await r.executeCommandInVty('enable', a, { passwordInput: 'Coffre15' });
    expect(await r.executeCommandInVty('show privilege', a))
      .toContain('Current privilege level is 15');
    expect(await r.executeCommandInVty('show privilege', b))
      .toContain('Current privilege level is 1');
    expect(await r.executeCommandInVty('show running-config', b)).toContain(REFUS);
    expect(await r.executeCommandInVty('show running-config', a))
      .toContain('Building configuration');

    r.closeVtySession(a);
    r.closeVtySession(b);
  }, 30_000);

  it('le mode de configuration de l\'un ne deplace pas l\'autre', async () => {
    const r = await cible();
    const a = r.openVtySession();
    const b = r.openVtySession();
    await r.executeCommandInVty('enable', a, { passwordInput: 'Coffre15' });
    await r.executeCommandInVty('configure terminal', a);
    await r.executeCommandInVty('interface GigabitEthernet0/0', a);

    expect(await r.executeCommandInVty('show privilege', b))
      .toContain('Current privilege level is 1');
    // `description` n'existe pas en EXEC : IOS la prend pour un nom
    // d'hote et tente de la resoudre. Ce qui compte est verifie a cote —
    // la session b n'est PAS dans le sous-mode d'interface de la a.
    expect(await r.executeCommandInVty('description PIRATE', b))
      .toMatch(/Translating "|% Unknown command|% Invalid input/);
    expect(await r.executeCommandInVty('show privilege', b)).toContain('level is 1');

    r.closeVtySession(a);
    r.closeVtySession(b);
  }, 30_000);

  it('une regle posee par l\'un vaut pour l\'autre — elle appartient a la MACHINE', async () => {
    const r = await cible();
    const admin = r.openVtySession();
    const tech = r.openVtySession();
    await r.executeCommandInVty('enable', tech, { passwordInput: 'Coffre15' });
    await r.executeCommandInVty('disable 7', tech);
    expect(await r.executeCommandInVty('show privilege', tech))
      .toContain('Current privilege level is 7');
    // `show clock` est une commande de NIVEAU 1 sur un vrai IOS : mauvais
    // cobaye. `show running-config` nait au niveau 15, elle.
    expect(await r.executeCommandInVty('show running-config', tech)).toContain(REFUS);

    await r.executeCommandInVty('enable', admin, { passwordInput: 'Coffre15' });
    await r.executeCommandInVty('configure terminal', admin);
    await r.executeCommandInVty('privilege exec level 7 show running-config', admin);
    await r.executeCommandInVty('end', admin);

    expect(await r.executeCommandInVty('show running-config', tech))
      .toContain('Building configuration');

    r.closeVtySession(admin);
    r.closeVtySession(tech);
  }, 30_000);

  it('une vue creee par l\'un est visible de l\'autre', async () => {
    const r = await cible();
    const admin = r.openVtySession();
    await r.executeCommandInVty('enable', admin, { passwordInput: 'Coffre15' });
    await r.executeCommandInVty('configure terminal', admin);
    await r.executeCommandInVty('parser view LECTURE', admin);
    await r.executeCommandInVty('secret Lect2026', admin);
    await r.executeCommandInVty('commands exec include show version', admin);
    await r.executeCommandInVty('end', admin);

    const autre = r.openVtySession();
    await r.executeCommandInVty('enable', autre, { passwordInput: 'Coffre15' });
    expect(await r.executeCommandInVty('show parser view all', autre)).toContain('LECTURE');

    r.closeVtySession(admin);
    r.closeVtySession(autre);
  }, 30_000);
});

describe('REVOCATION — retirer un droit a quelqu\'un de deja connecte', () => {
  it('la commande retiree disparait de la session ouverte, tout de suite', async () => {
    const r = await cible();
    const tech = r.openVtySession();
    await r.executeCommandInVty('enable', tech, { passwordInput: 'Coffre15' });
    await r.executeCommandInVty('disable 7', tech);
    // `show ip interface brief` nait au niveau 1 : la retirer du niveau 7
    // ne la retire de rien. On mesure sur une commande nee au niveau 15,
    // descendue puis reprise.
    const admin = r.openVtySession();
    await r.executeCommandInVty('enable', admin, { passwordInput: 'Coffre15' });
    await r.executeCommandInVty('configure terminal', admin);
    await r.executeCommandInVty('privilege exec level 7 show running-config', admin);
    await r.executeCommandInVty('end', admin);
    expect(await r.executeCommandInVty('show running-config', tech))
      .toContain('Building configuration');

    await r.executeCommandInVty('configure terminal', admin);
    await r.executeCommandInVty('privilege exec reset show running-config', admin);
    await r.executeCommandInVty('end', admin);

    expect(await r.executeCommandInVty('show running-config', tech)).toContain(REFUS);

    r.closeVtySession(admin);
    r.closeVtySession(tech);
  }, 30_000);

  it('un compte supprime ne se reconnecte plus, et sa session ouverte ne monte pas', async () => {
    const r = await cible();
    await r.loginAs('tech', 'Tech7');
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    await r.executeCommand('configure terminal');
    await r.executeCommand('no username tech');
    await r.executeCommand('end');
    await r.executeCommand('disable');

    expect(await r.loginAs('tech', 'Tech7')).toBe(false);
  }, 30_000);

  it('un compte verrouille ne se reconnecte plus, meme avec le bon secret', async () => {
    const r = await cible();
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    await r.executeCommand('configure terminal');
    await r.executeCommand('aaa local authentication attempts max-fail 2');
    await r.executeCommand('end');
    await r.executeCommand('disable');

    expect(await r.loginAs('tech', 'faux1')).toBe(false);
    expect(await r.loginAs('tech', 'faux2')).toBe(false);
    expect(await r.loginAs('tech', 'Tech7')).toBe(false);
  }, 30_000);
});

describe('LIGNE — le niveau declare sur la ligne, et la reserve de vty', () => {
  it('`privilege level` sous `line vty` figure dans la configuration', async () => {
    const r = await cible();
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    await r.executeCommand('configure terminal');
    await r.executeCommand('line vty 0 4');
    await r.executeCommand('privilege level 7');
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('line vty 0 4');
    expect(cfg).toContain('privilege level 7');
  }, 30_000);

  it('la reserve de vty est bornee, et une ligne de trop est refusee', async () => {
    const r = await cible();
    const ouvertes = [];
    for (let i = 0; i < 5; i++) ouvertes.push(r.openVtySession());
    const registre = r.getSshSessionRegistry();
    for (let i = 0; i < 5; i++) {
      registre.open({ user: `u${i}`, fromIp: `10.0.0.${i + 1}`, localPort: 22 });
    }
    expect(registre.hasFreeLine('vty')).toBe(false);
    expect(registre.open({ user: 'trop', fromIp: '10.0.0.99', localPort: 22 })).toBeNull();
    for (const s of ouvertes) r.closeVtySession(s);
  }, 30_000);
});

describe('AAA — l\'autorisation par commande, et son repli', () => {
  it('la base locale accorde quand le serveur ne repond pas', async () => {
    const r = await cible();
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    await r.executeCommand('configure terminal');
    await r.executeCommand('aaa authorization commands 15 default group tacacs+ local');
    await r.executeCommand('end');
    const verdict = await r.authenticateAAA({ user: 'chef', pass: 'Chef15' });
    expect(verdict.success).toBe(true);
    expect(verdict.methodUsed).toBe('local');
  }, 30_000);

  it('un mauvais secret reste refuse quel que soit le repli', async () => {
    const r = await cible();
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    await r.executeCommand('configure terminal');
    await r.executeCommand('aaa authentication login default group tacacs+ local');
    await r.executeCommand('end');
    expect((await r.authenticateAAA({ user: 'chef', pass: 'PasLeBon' })).success).toBe(false);
  }, 30_000);
});
