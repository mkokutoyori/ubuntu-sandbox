/**
 * `cdp` et `lldp` — six paires, six reglages, deux plateformes.
 *
 * Douze chemins de trie deviennent six declarations : chaque commande
 * d'activation portait sa negation comme un chemin separe, sans rien qui
 * garantisse que les deux visent le meme agent.
 *
 * Les six REGLAGES gagnent en plus un argument TYPE. Ils etaient
 * gloutons — `cdp timer` avalait tout ce qui suivait et faisait son
 * `parseInt` lui-meme — donc l'aide ne pouvait rien annoncer de la
 * valeur attendue. Declaree, la borne se lit dans `?`.
 *
 * Ce que ce fichier verifie surtout, c'est que le refus de valeur
 * SURVIT a la migration : une borne acceptee en silence serait un
 * reglage que l'operateur croit avoir pose.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';

interface Cli { executeCommand(command: string): Promise<string>; }

async function inConfig(type: 'router-cisco' | 'switch-cisco'): Promise<Cli> {
  const device = createDevice(type, 0, 0) as unknown as Cli;
  await device.executeCommand('enable');
  await device.executeCommand('configure terminal');
  return device;
}

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

describe('une paire, une declaration', () => {
  it('`cdp run` et `no cdp run` passent tous les deux', async () => {
    const r = await inConfig('router-cisco');

    expect(await r.executeCommand('cdp run')).not.toContain('Invalid input');
    expect(await r.executeCommand('no cdp run')).not.toContain('Invalid input');
  });

  it('l\'etat suit vraiment — la configuration rendue le dit', async () => {
    const r = await inConfig('router-cisco');

    await r.executeCommand('no cdp run');
    await r.executeCommand('end');

    expect(await r.executeCommand('show running-config')).toContain('no cdp run');
  });

  it('les commandes d\'interface visent le port selectionne', async () => {
    const r = await inConfig('router-cisco');
    await r.executeCommand('interface GigabitEthernet0/0');

    expect(await r.executeCommand('no cdp enable')).not.toContain('Invalid input');
    expect(await r.executeCommand('lldp transmit')).not.toContain('Invalid input');
    expect(await r.executeCommand('no lldp receive')).not.toContain('Invalid input');
  });

  it('le commutateur a la meme famille — declaree une seule fois', async () => {
    const sw = await inConfig('switch-cisco');

    expect(await sw.executeCommand('lldp run')).not.toContain('Invalid input');
    expect(await sw.executeCommand('no cdp run')).not.toContain('Invalid input');
  });
});

describe('un reglage garde sa borne', () => {
  it('une valeur dans la plage est acceptee', async () => {
    const r = await inConfig('router-cisco');

    expect(await r.executeCommand('cdp timer 30')).toBe('');
  });

  it('une valeur HORS plage est refusee par l\'ANALYSE, dans les mots d\'IOS', async () => {
    const r = await inConfig('router-cisco');

    expect(await r.executeCommand('cdp timer 3')).toContain('Invalid input');
    expect(await r.executeCommand('lldp holdtime-multiplier 99')).toContain('Invalid input');
  });

  it('et l\'aide, elle, NOMME la plage — c\'est la qu\'on l\'apprend', async () => {
    const r = await inConfig('router-cisco');

    expect(await r.executeCommand('cdp timer ?')).toContain('<5-254>');
    expect(await r.executeCommand('lldp holdtime-multiplier ?')).toContain('<2-10>');
  });

  it('un mot qui n\'est pas un nombre ne passe pas pour une valeur', async () => {
    const r = await inConfig('router-cisco');

    expect(await r.executeCommand('cdp timer zorglub')).toContain('Invalid input');
  });

  it('`cdp ?` annonce les suites, reglages compris', async () => {
    const r = await inConfig('router-cisco');

    const aide = await r.executeCommand('cdp ?');

    expect(aide).toContain('run');
    expect(aide).toContain('timer');
    expect(aide).toContain('holdtime');
  });


});
