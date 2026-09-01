/**
 * Trois familles du Catalyst qui vivent chacune dans deux ou trois
 * modes : l'agregation (LACP/PAgP), la detection de lien unidirectionnel
 * (UDLD), et la copie de trafic (SPAN).
 *
 * Elles sont prises ensemble parce qu'elles posent la meme question a la
 * CLI — ou vit chaque commande, et que rend-elle a la relecture — et
 * qu'aucune n'a de sous-mode.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
  getPortNames(): string[];
}

let serial = 0;

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

async function surUnPort(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal',
    `interface ${sw.getPortNames()[0]}`, ...lignes]) {
    await sw.executeCommand(c);
  }
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

describe('l agregation', () => {
  it('`lacp system-priority 100` est accepte et rendu', async () => {
    const cli = await commutateur('lacp system-priority 100');

    expect(await configuration(cli)).toContain('lacp system-priority 100');
  });

  /*
   * PREMISSE PERIMEE PAR LE MOTEUR. Ce cas datait du temps ou la
   * repartition de charge etait REFUSEE, faute de quoi que ce soit qui
   * distribue les trames entre les membres. `selectBundleMemberForFlow`
   * existe depuis, la methode est rangee, rendue et appliquee : la
   * commande fait desormais ce qu'elle promet, et exiger un refus
   * epinglerait un manque comble.
   *
   * Ce qu'il verifie a la place est ce qui manquait vraiment — le
   * defaut ne s'ecrit pas, l'ecart s'ecrit —, `src-mac` etant le defaut
   * d'un Catalyst 2960/3560, les chassis modelises ici.
   */
  it('`port-channel load-balance` range sa methode, et tait le defaut', async () => {
    const cli = await commutateur();

    expect(await cli.executeCommand('port-channel load-balance src-mac'))
      .not.toContain('Invalid input');
    expect(await configuration(cli)).not.toContain('port-channel load-balance');
  });

  it('et une methode qui n est PAS le defaut s ecrit', async () => {
    const cli = await commutateur();
    await cli.executeCommand('port-channel load-balance src-dst-ip');

    expect(await configuration(cli)).toContain('port-channel load-balance src-dst-ip');
  });

  it.each(['lacp rate fast', 'lacp port-priority 100'])(
    '`%s` est accepte sur le port', async (ligne) => {
      const cli = await surUnPort('channel-group 1 mode active');

      expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(false);
    });

  it('`lacp rate` n existe PAS en configuration globale', async () => {
    const cli = await commutateur();

    expect(refuse(await cli.executeCommand('lacp rate fast'))).toBe(true);
  });

  it.each(['show lacp neighbor', 'show lacp sys-id', 'show pagp'])(
    '`%s` repond en EXEC', async (vue) => {
      const cli = await commutateur();
      await cli.executeCommand('end');

      expect(refuse(await cli.executeCommand(vue)), vue).toBe(false);
    });

  it('`show lacp` SEULE est incomplete, comme sur IOS', async () => {
    const cli = await commutateur();
    await cli.executeCommand('end');

    expect(refuse(await cli.executeCommand('show lacp'))).toBe(true);
  });
});

describe('la detection de lien unidirectionnel', () => {
  it('`udld aggressive` est accepte et rendu', async () => {
    const cli = await commutateur('udld aggressive');

    expect(await configuration(cli)).toContain('udld aggressive');
  });

  it('`no udld` le retire', async () => {
    const cli = await commutateur('udld aggressive', 'no udld');

    expect(await configuration(cli)).not.toMatch(/^udld aggressive$/m);
  });

  it('`udld port aggressive` se pose sur le PORT', async () => {
    const cli = await surUnPort('udld port aggressive');

    expect(await configuration(cli)).toContain('udld port aggressive');
  });

  it('`show udld` repond en EXEC', async () => {
    const cli = await commutateur();
    await cli.executeCommand('end');

    expect(refuse(await cli.executeCommand('show udld'))).toBe(false);
  });
});

describe('la copie de trafic', () => {
  it('`monitor session 1 source interface <nom>` est accepte et rendu', async () => {
    const sw = await commutateur();
    const port = sw.getPortNames()[0];
    await sw.executeCommand(`monitor session 1 source interface ${port}`);

    expect(await configuration(sw)).toContain('monitor session 1 source interface');
  });

  it('`no monitor session 1` la retire', async () => {
    const sw = await commutateur();
    const port = sw.getPortNames()[0];
    await sw.executeCommand(`monitor session 1 source interface ${port}`);
    await sw.executeCommand('no monitor session 1');

    expect(await configuration(sw)).not.toContain('monitor session 1 source');
  });

  it('`show monitor` lit la session posee', async () => {
    const sw = await commutateur();
    const port = sw.getPortNames()[0];
    await sw.executeCommand(`monitor session 1 source interface ${port}`);
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show monitor')).toContain('1');
  });
});

describe('l aide de ces trois familles', () => {
  it('`udld ?` decrit ses modes', async () => {
    const cli = await commutateur();
    const aide = cli.cliHelp('udld ');

    expect(aide).toContain('aggressive');
  });

  it('`lacp ?` en configuration globale ne montre que ce qui y vit', async () => {
    const cli = await commutateur();
    const aide = cli.cliHelp('lacp ');

    expect(aide).toContain('system-priority');
    expect(aide).not.toContain('port-priority');
  });

  it('aucune ligne d aide de ces familles ne reste sans description', async () => {
    const cli = await commutateur();
    const nues: string[] = [];
    for (const amont of ['udld ', 'lacp ', 'monitor ', 'port-channel ']) {
      for (const ligne of cli.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
