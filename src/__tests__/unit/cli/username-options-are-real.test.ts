import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  loginAs(user: string, password: string): Promise<boolean>;
}

let serial = 0;

async function configured(...lines: string[]): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await device.executeCommand('enable');
  await device.executeCommand('configure terminal');
  for (const line of lines) await device.executeCommand(line);
  await device.executeCommand('end');
  return device;
}

async function enConfiguration(): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await device.executeCommand('enable');
  await device.executeCommand('configure terminal');
  return device;
}

async function usernameLines(device: Cli): Promise<string[]> {
  return (await device.executeCommand('show running-config'))
    .split('\n').filter(l => l.trimStart().startsWith('username '));
}

describe('l\'aide ne propose que ce que la machine fait', () => {
  it.each(['dnis', 'hidden', 'nocallback-verify', 'noescape', 'mac', 'common-criteria-policy'])(
    '`%s` n\'est plus proposee', async (option) => {
      const device = await enConfiguration();

      expect(device.cliHelp('username toto ')).not.toContain(option);
    });

  it.each([
    'username toto dnis',
    'username toto hidden',
    'username toto nocallback-verify',
    'username toto noescape',
    'username toto mac 0011.2233.4455',
    'username toto common-criteria-policy POL',
  ])('et `%s` est refusee plutot qu\'avalee', async (command) => {
    const device = await enConfiguration();

    expect(await device.executeCommand(command)).toContain('Invalid input');
  });

  it.each([
    'access-class', 'autocommand', 'description', 'nohangup',
    'nopassword', 'one-time', 'user-maxlinks', 'privilege', 'secret', 'view',
  ])('`%s` reste proposee — elle a un effet', async (option) => {
    const device = await enConfiguration();

    expect(device.cliHelp('username toto ')).toContain(option);
  });

  it('une option prend sa VALEUR, pas la liste entiere', async () => {
    const device = await enConfiguration();

    expect(device.cliHelp('username toto user-maxlinks ')).toContain('<0-255>');
    expect(device.cliHelp('username toto user-maxlinks ')).not.toContain('nopassword');
  });
});

describe('un compte SANS mot de passe n\'en rend pas un', () => {
  it('`nopassword` est rendu tel quel, pas en condense du vide', async () => {
    const device = await configured('username sansmdp nopassword');

    const rendu = (await usernameLines(device)).find(l => l.includes('sansmdp'))!;

    expect(rendu).toBe('username sansmdp nopassword');
    expect(rendu).not.toContain('secret');
  });

  it('et il OUVRE, la ou un compte sans secret reste ferme', async () => {
    const device = await configured(
      'username ouvert nopassword',
      'username ferme access-class 10',
    );

    expect(await device.loginAs('ouvert', '')).toBe(true);
    expect(await device.loginAs('ferme', '')).toBe(false);
  });

  it('poser un secret ensuite retire `nopassword`', async () => {
    const device = await configured('username u nopassword');
    await device.executeCommand('configure terminal');
    await device.executeCommand('username u secret Bon@2026');
    await device.executeCommand('end');

    const rendu = (await usernameLines(device)).find(l => l.startsWith('username u '))!;

    expect(rendu).toContain('secret 5 $1$');
    expect(rendu).not.toContain('nopassword');
    expect(await device.loginAs('u', '')).toBe(false);
    expect(await device.loginAs('u', 'Bon@2026')).toBe(true);
  });
});

describe('la configuration REPRODUIT le compte, option comprise', () => {
  it.each([
    ['username u description Chef du reseau', 'username u description Chef du reseau'],
    ['username u autocommand show clock', 'username u autocommand show clock'],
    ['username u access-class 10 secret x', 'username u access-class 10 secret'],
    ['username u user-maxlinks 3 secret x', 'username u user-maxlinks 3 secret'],
    ['username u one-time secret x', 'username u one-time secret'],
    ['username u nohangup autocommand show clock', 'username u nohangup'],
  ])('`%s` ressort dans la configuration', async (command, attendu) => {
    const device = await configured(command);

    expect((await usernameLines(device)).join('\n')).toContain(attendu);
  });

  it('et une machine qui REJOUE cette configuration retrouve les memes comptes', async () => {
    const source = await configured(
      'username u access-class 10 user-maxlinks 2 one-time nohangup secret Bon@2026',
      'username v nopassword',
      'username w description Compte de garde',
    );
    const lignes = await usernameLines(source);

    const cible = new CiscoRouter('R-import') as unknown as Cli;
    await cible.executeCommand('enable');
    await cible.executeCommand('configure terminal');
    for (const l of lignes) await cible.executeCommand(l.trim());
    await cible.executeCommand('end');

    expect(await usernameLines(cible)).toEqual(lignes);
  });
});

describe('`one-time` : le compte DISPARAIT apres la premiere connexion', () => {
  it('la premiere ouvre, la seconde non', async () => {
    const device = await configured('username jetable one-time secret Bon@2026');

    expect(await device.loginAs('jetable', 'Bon@2026')).toBe(true);
    expect(await device.loginAs('jetable', 'Bon@2026')).toBe(false);
  });

  it('et il quitte la configuration', async () => {
    const device = await configured('username jetable one-time secret Bon@2026');

    expect((await usernameLines(device)).join('\n')).toContain('jetable');

    await device.loginAs('jetable', 'Bon@2026');

    expect((await usernameLines(device)).join('\n')).not.toContain('jetable');
  });

  it('un compte ordinaire resservira — le temoin', async () => {
    const device = await configured('username durable secret Bon@2026');

    expect(await device.loginAs('durable', 'Bon@2026')).toBe(true);
    expect(await device.loginAs('durable', 'Bon@2026')).toBe(true);
  });
});

describe('`user-maxlinks` refuse la session de trop', () => {
  it('une seule session autorisee, la seconde est refusee', async () => {
    const device = await configured('username seul user-maxlinks 1 secret Bon@2026');

    expect(await device.loginAs('seul', 'Bon@2026')).toBe(true);
    expect(await device.loginAs('seul', 'Bon@2026')).toBe(false);
  });

  it('sans la commande, rien ne limite — le temoin', async () => {
    const device = await configured('username libre secret Bon@2026');

    expect(await device.loginAs('libre', 'Bon@2026')).toBe(true);
    expect(await device.loginAs('libre', 'Bon@2026')).toBe(true);
  });

  it('une valeur hors bornes est refusee, pas rangee', async () => {
    const device = await enConfiguration();

    expect(await device.executeCommand('username u user-maxlinks 999')).toContain('Invalid input');
    expect(await device.executeCommand('username u user-maxlinks toto')).toContain('Invalid input');
  });
});

describe('`access-class` refuse une source que la liste refuse', () => {
  it('une liste qui refuse tout ferme le compte', async () => {
    const device = await configured(
      'access-list 10 deny any',
      'username filtre access-class 10 secret Bon@2026',
    );

    expect(await device.loginAs('filtre', 'Bon@2026')).toBe(false);
  });

  it('une liste qui permet tout le laisse ouvert — le temoin', async () => {
    const device = await configured(
      'access-list 11 permit any',
      'username filtre access-class 11 secret Bon@2026',
    );

    expect(await device.loginAs('filtre', 'Bon@2026')).toBe(true);
  });

  it('un numero hors bornes est refuse', async () => {
    const device = await enConfiguration();

    expect(await device.executeCommand('username u access-class 500')).toContain('Invalid input');
  });
});

describe('`autocommand` emet vraiment la commande', () => {
  it('la connexion laisse la trace de la commande dans l\'historique', async () => {
    const device = await configured(
      'username auto autocommand show clock',
      'username auto secret Bon@2026',
    );

    await device.loginAs('auto', 'Bon@2026');

    expect(await device.executeCommand('show history')).toContain('show clock');
  });

  it('sans la commande, rien n\'est emis — le temoin', async () => {
    const device = await configured('username nu secret Bon@2026');

    await device.loginAs('nu', 'Bon@2026');

    expect(await device.executeCommand('show history')).not.toContain('show clock');
  });
});

describe('le commutateur applique la MEME regle — un seul rendu', () => {
  async function switchDevice(...lines: string[]): Promise<Cli> {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');
    await device.executeCommand('configure terminal');
    for (const l of lines) await device.executeCommand(l);
    await device.executeCommand('end');
    return device;
  }

  it('`nopassword` y est rendu comme sur le routeur', async () => {
    const device = await switchDevice('username sansmdp nopassword');

    expect((await usernameLines(device)).join('\n'))
      .toContain('username sansmdp nopassword');
  });

  it('et `description` y ressort aussi', async () => {
    const device = await switchDevice('username u description Compte de garde');

    expect((await usernameLines(device)).join('\n'))
      .toContain('username u description Compte de garde');
  });
});
