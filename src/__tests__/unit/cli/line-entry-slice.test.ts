/**
 * `line {console|vty|aux|tty} <premiere> [<derniere>]` — la porte du
 * sous-mode de configuration de ligne.
 *
 * C'est par elle que passent le mot de passe de console, le delai
 * d'inactivite, `transport input` et la liste de controle des vty :
 * autrement dit tout l'acces d'administration. Une porte qui accepte
 * n'importe quoi met l'operateur dans un sous-mode qui ne configure
 * rien, et le reglage qu'il tape ensuite tombe dans le vide sans qu'un
 * seul message le dise.
 *
 * Ce qui est mesure ici : ce que la porte ACCEPTE, ce qu'elle REFUSE,
 * et que le sous-mode ou elle mene est bien celui de la ligne nommee.
 * Le comportement des reglages eux-memes est mesure ailleurs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  getPrompt?(): string;
}

let serial = 0;

async function routeur(...lignes: string[]): Promise<Cli> {
  const r = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  r.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await r.executeCommand(c);
  return r;
}

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

/*
 * Le bloc de console se rend `line console 0` et non `line con 0` : les
 * deux formes existent sur une vraie machine — `con` est l'abreviation
 * — et une sortie `show running-config` publiee par Cisco ecrit
 * `line console 0`. La sonde attendait d'abord la forme abregee, sans
 * reference pour la departager : c'est la sonde qui avait tort.
 */
const LIGNES: readonly string[] = ['line console 0', 'line vty 0 4', 'line aux 0'];

describe('chaque sorte de ligne ENTRE dans le sous-mode', () => {
  it.each(LIGNES)('`%s` mene a `config-line`',
    async (porte) => {
      const r = await routeur(porte);

      expect(refuse(await r.executeCommand(porte)), porte).toBe(false);
      expect(r.getPrompt?.() ?? '', porte).toMatch(/config-line/);
    });

  it.each(LIGNES)(
    '`%s` puis `exec-timeout 5 0` est accepte', async (porte) => {
      const r = await routeur(porte);

      expect(refuse(await r.executeCommand('exec-timeout 5 0')), porte).toBe(false);
    });

  /*
   * Le reglage doit atterrir sur la ligne NOMMEE : sans cela le
   * sous-mode est une facade, et deux `line` successives configurent la
   * meme chose.
   */
  it('deux plages vty distinctes gardent chacune son reglage', async () => {
    const r = await routeur(
      'line vty 0 4', 'exec-timeout 5 0', 'exit',
      'line vty 5 15', 'exec-timeout 30 0');
    const cfg = await configuration(r);

    expect(cfg).toContain('line vty 0 4');
    expect(cfg).toContain('line vty 5 15');
    expect(cfg).toMatch(/exec-timeout 5 0/);
    expect(cfg).toMatch(/exec-timeout 30 0/);
  });

  it('le mot de passe de console est rendu sous la console, pas sous les vty',
    async () => {
      const r = await routeur(
        'line console 0', 'password cisco', 'login', 'exit',
        'line vty 0 4', 'password vtypass', 'login');
      const cfg = await configuration(r);
      const apresConsole = cfg.slice(cfg.indexOf('line console 0'));

      expect(cfg).toContain('line console 0');
      expect(apresConsole.slice(0, apresConsole.indexOf('line vty')))
        .toContain('password cisco');
      expect(cfg.slice(cfg.indexOf('line vty'))).toContain('password vtypass');
    });
});

describe('les abreviations attestees', () => {
  /*
   * `con` est l'abreviation de `console`, et quatre laboratoires de ce
   * depot la tapent. Elle se resout par prefixe et n'est donc pas une
   * cinquieme sorte de ligne — `line ?` n'en annonce que quatre.
   */
  it('`line con 0` designe la console', async () => {
    const r = await routeur('line con 0', 'password cisco', 'login');

    expect(await configuration(r)).toContain('line console 0');
  });

  it('et `line ?` n annonce pas `con` a cote de `console`', async () => {
    const r = await routeur();
    const sortes = r.cliHelp('line ').split('\n')
      .map(l => /^\s\s(\S+)/.exec(l)?.[1])
      .filter((m): m is string => m !== undefined && m !== '<cr>');

    expect(sortes.sort()).toEqual(['aux', 'console', 'tty', 'vty']);
  });
});

describe('passer d une ligne a l autre sans repasser par la configuration', () => {
  it('`line vty 5 15` depuis `config-line` change de ligne', async () => {
    const r = await routeur('line vty 0 4', 'exec-timeout 5 0');

    expect(refuse(await r.executeCommand('line vty 5 15'))).toBe(false);
    await r.executeCommand('exec-timeout 30 0');
    const cfg = await configuration(r);

    expect(cfg).toContain('line vty 0 4');
    expect(cfg).toContain('line vty 5 15');
  });
});

describe('ce que la porte REFUSE', () => {
  it('`line` seul est incomplet', async () => {
    const r = await routeur();

    expect(await r.executeCommand('line')).toContain('Incomplete');
  });

  it('une SORTE de ligne inventee est refusee', async () => {
    const r = await routeur();

    expect(refuse(await r.executeCommand('line zorglub 0'))).toBe(true);
  });

  /*
   * Une sorte de ligne inventee ne doit pas non plus DEPLACER
   * l'operateur : se retrouver en `config-line` apres un refus laisse
   * taper des reglages dans un sous-mode qui ne designe aucune ligne.
   */
  it('et elle ne fait pas entrer dans le sous-mode', async () => {
    const r = await routeur();
    await r.executeCommand('line zorglub 0');

    expect(r.getPrompt?.() ?? '').not.toMatch(/config-line/);
  });

  it('une sorte de ligne SANS numero est incomplete', async () => {
    const r = await routeur();

    expect(await r.executeCommand('line vty')).toContain('Incomplete');
  });

  it('un numero de vty hors plage est refuse', async () => {
    const r = await routeur();

    expect(refuse(await r.executeCommand('line vty 99'))).toBe(true);
  });

  it('un numero qui n est pas un nombre est refuse', async () => {
    const r = await routeur();

    expect(refuse(await r.executeCommand('line vty zorglub'))).toBe(true);
  });

  /*
   * `line vty 5 2` decrit une plage a l'envers : la derniere ligne
   * precede la premiere. `no line vty 5 2` est deja refuse par le
   * gestionnaire de la negation ; la porte positive doit l'etre aussi,
   * sans quoi la meme plage est posable et non retirable.
   */
  it('une plage a l ENVERS est refusee', async () => {
    const r = await routeur();

    expect(refuse(await r.executeCommand('line vty 5 2'))).toBe(true);
  });
});

describe('la negation', () => {
  it('`no line vty 5 15` retire le bloc', async () => {
    const r = await routeur('line vty 5 15', 'exec-timeout 30 0', 'exit',
      'no line vty 5 15');

    expect(await configuration(r)).not.toContain('line vty 5 15');
  });

  it.each(['no line console 0', 'no line aux 0'])(
    '`%s` est refuse — un chassis ne perd pas sa console', async (ligne) => {
      const r = await routeur();

      expect(await r.executeCommand(ligne)).toMatch(/delete/i);
    });
});

describe('le commutateur repond comme le routeur', () => {
  it.each(['line console 0', 'line vty 0 4'])('`%s`', async (porte) => {
    const sw = await commutateur(porte);

    expect(refuse(await sw.executeCommand('exec-timeout 5 0')), porte).toBe(false);
  });

  it('une sorte de ligne inventee y est refusee aussi', async () => {
    const sw = await commutateur();

    expect(refuse(await sw.executeCommand('line zorglub 0'))).toBe(true);
  });
});

describe('l aide de la famille', () => {
  it('`line ?` annonce les sortes de ligne', async () => {
    const r = await routeur();
    const aide = r.cliHelp('line ');

    for (const sorte of ['aux', 'console', 'vty']) expect(aide, sorte).toContain(sorte);
  });

  it('`line vty ?` annonce la plage des vty', async () => {
    const r = await routeur();

    expect(r.cliHelp('line vty ')).toMatch(/<0-\d+>/);
  });

  it('`line console ?` annonce la plage de la console', async () => {
    const r = await routeur();

    expect(r.cliHelp('line console ')).toMatch(/<0-\d+>/);
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const r = await routeur();
    const nues: string[] = [];
    for (const amont of ['line ', 'line vty ', 'line console ', 'no line ']) {
      for (const ligne of r.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
