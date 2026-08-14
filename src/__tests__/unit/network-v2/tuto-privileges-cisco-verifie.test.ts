/**
 * Le tutoriel des privileges, joue comme laboratoire.
 *
 * `docs/tutoriel-privileges-cisco.md` annonce que toutes ses sorties sont
 * capturees plutot que retapees. Cette sonde est ce qui rend cette phrase
 * verifiable : elle rejoue le laboratoire dans l'ordre du tutoriel et
 * verifie chaque affirmation qu'il fait.
 *
 * Elle existe a cause d'une erreur reelle. La premiere version deleguait
 * `show ip route` au niveau 5 en annoncant « le niveau 5 doit pouvoir
 * consulter la table de routage » — or `show ip route` est DEJA au
 * niveau 1 sur IOS. La regle ne donnait donc rien a personne : elle
 * RETIRAIT la commande au niveau 1. Le piege montre restait vrai, mais
 * l'exemple qui l'illustrait etait a l'envers, et rien ne l'avait
 * signale parce que rien ne relisait le tutoriel.
 *
 * Un document qui affirme des sorties et qu'aucun test ne joue derive au
 * premier changement du produit. Celui-ci ne le peut plus.
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

type R = CiscoRouter & {
  cliHelp(s: string): string;
  executeCommand(c: string, o?: { passwordInput?: string }): Promise<string>;
};

async function jouer(r: R, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await r.executeCommand(c);
  return derniere;
}

/** Le laboratoire du tutoriel, jusqu'aux trois portes. */
async function labo(nom: string): Promise<R> {
  const r = new CiscoRouter(nom) as R;
  await jouer(r, [
    'enable', 'configure terminal', 'hostname R1',
    'enable secret Coffre15!',
    'enable secret level 5 Tech5!',
    'enable secret level 10 Admin10!',
    'end',
  ]);
  return r;
}

describe('§ Ce qu IOS appelle un privilege', () => {
  it('le niveau 1 a deja `show ip route`, `show version` et `ping`', async () => {
    const r = new CiscoRouter('R0') as R;
    expect(await r.executeCommand('show privilege')).toContain('level is 1');
    for (const c of ['show ip route', 'show version', 'show ip interface brief']) {
      expect(String(await r.executeCommand(c)), c).not.toContain('Invalid input');
    }
  });

  it('mais pas `show running-config`, qui vit au niveau 15', async () => {
    const r = new CiscoRouter('R0b') as R;
    expect(await r.executeCommand('show running-config')).toBe(REFUS);
  });
});

describe('§ Premier contact', () => {
  it('`show privilege` dit le niveau, et le refus est `% Invalid input`', async () => {
    const r = await labo('R1');
    expect(await r.executeCommand('show privilege')).toBe('Current privilege level is 15');
    await r.executeCommand('disable');
    expect(await r.executeCommand('show privilege')).toBe('Current privilege level is 1');
    expect(await r.executeCommand('show running-config')).toBe(REFUS);
  });
});

describe('§ Une porte par niveau', () => {
  it('les trois secrets sont stockes en condense de type 5', async () => {
    const r = await labo('R2');
    const bloc = await r.executeCommand('show running-config | include enable secret');
    expect(bloc).toMatch(/^enable secret 5 \$1\$/m);
    expect(bloc).toMatch(/^enable secret level 5 5 \$1\$/m);
    expect(bloc).toMatch(/^enable secret level 10 5 \$1\$/m);
  });

  it('`enable 5` ouvre le niveau 5, et le prompt porte le diese', async () => {
    const r = await labo('R3');
    await r.executeCommand('disable');
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    expect(await r.executeCommand('show privilege')).toContain('level is 5');
    expect(r.getPrompt()).toBe('R1#');
  });

  it('un mauvais secret donne trois refus puis `% Bad secrets`', async () => {
    const r = await labo('R4');
    await r.executeCommand('disable');
    const out = await r.executeCommand('enable 5', { passwordInput: 'mauvais' });
    expect(out).toContain('% Access denied');
    expect(out).toContain('% Bad secrets');
  });
});

describe('§ Deleguer sa premiere commande — et le piege', () => {
  /** Le laboratoire du tutoriel apres la delegation, sans le remede. */
  async function delegue(nom: string): Promise<R> {
    const r = await labo(nom);
    await jouer(r, [
      'configure terminal', 'privilege exec level 5 show running-config', 'end',
    ]);
    return r;
  }

  it('la delegation donne bien la commande au niveau 5', async () => {
    const r = await delegue('R5');
    await r.executeCommand('disable');
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    expect(await r.executeCommand('show privilege')).toContain('level is 5');
    expect(await r.executeCommand('show running-config')).toContain('Building configuration...');
  });

  it('LE PIEGE : le niveau 1 perd toute la branche `show`', async () => {
    const r = await delegue('R6');
    await r.executeCommand('disable');
    for (const c of ['show version', 'show ip route', 'show privilege']) {
      expect(await r.executeCommand(c), c).toBe(REFUS);
    }
  });

  it('LE REMEDE : `privilege exec level 1 show` rend les trois', async () => {
    const r = await delegue('R7');
    await jouer(r, ['configure terminal', 'privilege exec level 1 show', 'end', 'disable']);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show ip route')).toContain('Codes:');
    expect(await r.executeCommand('show privilege')).toContain('level is 1');
    // …sans rendre au niveau 1 ce qu'on venait d'en retirer.
    expect(await r.executeCommand('show running-config')).toBe(REFUS);
  });

  it('et le niveau 5 garde ce qu on lui a donne', async () => {
    const r = await delegue('R8');
    await jouer(r, ['configure terminal', 'privilege exec level 1 show', 'end', 'disable']);
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    expect(await r.executeCommand('show running-config')).toContain('Building configuration...');
  });
});

describe('§ Le mot-cle `all`', () => {
  async function socle(nom: string, avecAll: boolean): Promise<R> {
    const r = await labo(nom);
    await jouer(r, [
      'configure terminal',
      'privilege exec level 1 show',
      avecAll
        ? 'privilege exec all level 5 show running-config'
        : 'privilege exec level 5 show running-config',
      'end', 'disable',
    ]);
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    return r;
  }

  it('sans `all`, ce qui COMPLETE la commande ne passe pas', async () => {
    const r = await socle('R9', false);
    expect(await r.executeCommand('show running-config')).toContain('Building configuration...');
    expect(await r.executeCommand('show running-config interface GigabitEthernet0/0')).toBe(REFUS);
  });

  it('avec `all`, toute la branche passe', async () => {
    const r = await socle('R10', true);
    expect(await r.executeCommand('show running-config interface GigabitEthernet0/0'))
      .toContain('interface GigabitEthernet0/0');
  });
});

describe('§ Les quatre espaces de commandes', () => {
  async function technicien(nom: string): Promise<R> {
    const r = await labo(nom);
    await jouer(r, [
      'configure terminal',
      'privilege exec level 1 show',
      'privilege exec level 5 configure',
      'privilege exec level 5 configure terminal',
      'privilege configure level 5 interface',
      'privilege interface level 5 description',
      'privilege interface level 5 shutdown',
      'end', 'disable',
    ]);
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    return r;
  }

  it('il decrit et coupe une interface, et ne lui donne pas d adresse', async () => {
    const r = await technicien('R11');
    expect(await r.executeCommand('configure terminal'))
      .toContain('Enter configuration commands');
    expect(await r.executeCommand('interface GigabitEthernet0/0')).toBe('');
    expect(await r.executeCommand('description LIEN-VERS-LE-SIEGE')).toBe('');
    expect(await r.executeCommand('shutdown')).toBe('');
    expect(await r.executeCommand('ip address 10.0.0.1 255.255.255.0')).toBe(REFUS);
  });
});

describe('§ `show running-config` au niveau reduit', () => {
  it('le niveau 5 ne voit que ce qu il peut modifier', async () => {
    const r = await labo('R12');
    await jouer(r, [
      'configure terminal',
      'snmp-server community SECRETE RO',
      'privilege exec level 1 show',
      'privilege exec all level 5 show running-config',
      'privilege exec level 5 configure',
      'privilege exec level 5 configure terminal',
      'privilege configure level 5 interface',
      'privilege interface level 5 description',
      'end', 'disable',
    ]);
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    const vue = await r.executeCommand('show running-config');
    expect(vue).toContain('interface GigabitEthernet0/0');
    expect(vue).not.toContain('SECRETE');
    expect(vue).not.toContain('enable secret');
    expect(vue).not.toContain('privilege exec');
    // L'en-tete compte ce qui est rendu, pas ce qui est cache.
    const annonce = Number(/Current configuration : (\d+) bytes/.exec(vue)?.[1]);
    const corps = vue.split('\n').slice(4).join('\n');
    expect(annonce).toBe(new TextEncoder().encode(corps).length + 1);
  });
});

describe('§ Les comptes, la ligne, et qui gagne', () => {
  it('le compte porte son niveau', async () => {
    const r = await labo('R13');
    await jouer(r, [
      'configure terminal',
      'username arthur privilege 5 secret Arthur5!',
      'line console 0', 'login local', 'exit', 'end', 'exit',
    ]);
    expect(await r.loginAs('arthur', 'Arthur5!')).toBe(true);
    expect(await r.executeCommand('show privilege')).toContain('level is 5');
  });

  it('la LIGNE remplace le niveau du compte', async () => {
    const r = await labo('R14');
    await jouer(r, [
      'configure terminal',
      'username arthur privilege 5 secret Arthur5!',
      'line console 0', 'login local', 'privilege level 15', 'exit', 'end', 'exit',
    ]);
    expect(await r.loginAs('arthur', 'Arthur5!')).toBe(true);
    expect(await r.executeCommand('show privilege')).toContain('level is 15');
  });
});

describe('§ Les vues CLI', () => {
  async function avecVues(nom: string): Promise<R> {
    const r = await labo(nom);
    await jouer(r, [
      'configure terminal', 'aaa new-model',
      'parser view NOC', 'secret Vue@NOC2026',
      'commands exec include show version',
      'commands exec include show ip interface brief',
      'commands exec include ping', 'exit',
      'parser view SUPPORT', 'secret Vue@SUP2026',
      'commands exec include show interfaces', 'exit',
      'parser view TOUT superview', 'secret Vue@TOUT2026',
      'view NOC', 'view SUPPORT', 'exit',
      'end',
    ]);
    return r;
  }

  it('`parser view` exige `aaa new-model`', async () => {
    const r = await labo('R15');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('parser view NOC'))
      .toBe('%Parser view commands are not available. AAA must be enabled first');
  });

  it('une faute de frappe est refusee a l inclusion', async () => {
    const r = await labo('R16');
    await jouer(r, ['configure terminal', 'aaa new-model', 'parser view NOC']);
    expect(await r.executeCommand('commands exec include shwo verison')).toBe('%Command not found');
  });

  it('ce que la vue inclut s execute, ce qu elle exclut est ABSENT', async () => {
    const r = await avecVues('R17');
    await r.executeCommand('enable view NOC', { passwordInput: 'Vue@NOC2026' });
    expect(await r.executeCommand('show parser view')).toBe("Current view is 'NOC'");
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    for (const c of ['show ip route', 'configure terminal', 'show running-config']) {
      expect(await r.executeCommand(c), c).toBe(REFUS);
    }
  });

  it('on sort toujours d une vue', async () => {
    const r = await avecVues('R18');
    await r.executeCommand('enable view NOC', { passwordInput: 'Vue@NOC2026' });
    expect(await r.executeCommand('exit')).toContain('Connection closed');
  });

  it('la supervue compose les deux roles, et rien de plus', async () => {
    const r = await avecVues('R19');
    await r.executeCommand('enable view TOUT', { passwordInput: 'Vue@TOUT2026' });
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show interfaces GigabitEthernet0/0'))
      .toContain('GigabitEthernet0/0 is');
    expect(await r.executeCommand('show ip route')).toBe(REFUS);
  });

  it('`show parser view all` marque la supervue et porte sa legende', async () => {
    const r = await avecVues('R20');
    const lignes = (await r.executeCommand('show parser view all')).split('\n');
    expect(lignes[0]).toBe('Views/SuperViews Present in System:');
    expect(lignes).toContain('NOC');
    expect(lignes).toContain('TOUT *');
    expect(lignes[lignes.length - 1]).toBe('-------(*) represent superview-------');
  });
});

describe('§ include-exclusive et exclude', () => {
  it('`include-exclusive` reserve la commande, et le refus nomme la vue', async () => {
    const r = await labo('R21');
    await jouer(r, [
      'configure terminal', 'aaa new-model',
      'parser view A', 'secret Vue@A2026',
      'commands exec include-exclusive show ip route', 'exit',
      'parser view B', 'secret Vue@B2026',
    ]);
    expect(await r.executeCommand('commands exec include show ip route'))
      .toBe('%Command is set as include-exclusive in view A');
  });

  it('`exclude` retire une commande d une branche incluse par `all`', async () => {
    const r = await labo('R22');
    await jouer(r, [
      'configure terminal', 'aaa new-model',
      'parser view A', 'secret Vue@A2026',
      'commands exec include all show',
      'commands exec exclude show running-config', 'exit', 'end',
    ]);
    await r.executeCommand('enable view A', { passwordInput: 'Vue@A2026' });
    expect(await r.executeCommand('show clock')).toContain('UTC');
    expect(await r.executeCommand('show ip route')).toContain('Codes:');
    expect(await r.executeCommand('show running-config')).toBe(REFUS);
  });

  it('un mauvais secret de vue est refuse', async () => {
    const r = await labo('R23');
    await jouer(r, [
      'configure terminal', 'aaa new-model',
      'parser view A', 'secret Vue@A2026',
      'commands exec include show version', 'exit', 'end',
    ]);
    expect(await r.executeCommand('enable view A', { passwordInput: 'mauvais' }))
      .toContain('% Bad secrets');
  });
});
