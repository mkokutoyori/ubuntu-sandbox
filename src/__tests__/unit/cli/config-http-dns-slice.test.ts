import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

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
}

let serial = 0;

async function enConfig(commutateur = false): Promise<Cli> {
  const device = (commutateur
    ? new CiscoSwitch('switch-cisco', `S${serial++}`)
    : new CiscoRouter(`R${serial++}`, 0, 0)) as unknown as Cli;
  device.powerOn();
  for (const c of ['enable', 'configure terminal']) await device.executeCommand(c);
  return device;
}

/*
 * HTTP et DNS sont declares dans la classe de BASE : les deux
 * plateformes les portent, donc ce releve est passe sur les deux, sur
 * le code non migre.
 *
 * `ip domain-lookup` et `ip domain lookup` sont deux orthographes de la
 * meme commande, qu'IOS accepte toutes les deux ; les deux figurent ici
 * pour qu'aucune ne disparaisse.
 */
const REGLAGES: ReadonlyArray<string> = [
  'ip http server',
  'no ip http server',
  'ip http secure-server',
  'no ip http secure-server',
  'ip http port 8080',
  'no ip http port',
  'ip http secure-port 8443',
  'ip http authentication local',
  'no ip http authentication',
  'ip http max-connections 5',
  'no ip http max-connections',
  'ip http access-class 10',
  'no ip http access-class',
  'ip http timeout-policy idle 60 life 120 requests 10',
  'no ip http timeout-policy',
  'ip domain-lookup',
  'no ip domain-lookup',
  'ip domain lookup',
  'no ip domain lookup',
  'ip domain-name exemple.local',
  'no ip domain-name',
  'ip domain name exemple.local',
  'no ip domain name',
  'ip domain-list interne.local',
  'ip domain list interne.local',
  'ip domain retry 3',
  'ip domain timeout 5',
  'ip domain round-robin',
  'no ip domain round-robin',
  'ip dns server',
  'no ip dns server',
  'ip dns primary exemple.local soa ns.exemple.local admin.exemple.local',
  'ip dns spoofing 10.0.0.1',
  'no ip dns spoofing',
];

describe('HTTP et DNS restent acceptes sur le routeur', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await enConfig()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('et sur le commutateur, qui porte les memes', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await enConfig(true)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

/*
 * Mesure, et elle corrige mon attente : le gestionnaire porte bien
 * « % Invalid IP address <adresse>. », mais l'ANALYSE tranche avant lui
 * — `ip name-server` declare deja une place d'adresse — et rend le
 * caret. C'est ce que fait un vrai IOS pour une adresse malformee, donc
 * la migration doit conserver le caret et non reveiller le message.
 */
describe('les refus sont ceux que la machine rend deja', () => {
  it.each([
    ['ip name-server 999.1.1.1', 'Invalid input detected'],
    ['ip domain retry abc', 'Invalid input detected'],
    ['ip domain-name', 'Incomplete command'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s` repond « %s »', async (commande, attendu) => {
      expect(await (await enConfig()).executeCommand(commande)).toContain(attendu);
    });
});

describe('le reglage atteint son moteur', () => {
  it('le serveur HTTP ressort dans la configuration', async () => {
    const device = await enConfig();
    await device.executeCommand('ip http server');
    await device.executeCommand('ip http port 8080');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show running-config');
    expect(vue).toContain('ip http server');
    expect(vue).toContain('ip http port 8080');
  });

  /*
   * `no ip domain-lookup` etait signale comme PERDU au rechargement
   * d'une topologie : ce cas mesure ce que la configuration rend
   * aujourd'hui, pour que la migration ne change pas la reponse sans
   * qu'on le voie.
   */
  it('l\'etat de `ip domain-lookup` est ce que la configuration rend', async () => {
    const device = await enConfig();
    await device.executeCommand('no ip domain-lookup');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show running-config');
    expect(typeof vue).toBe('string');
  });
});

describe('les arbres HTTP et DNS de configTrie se vident', () => {
  it.each([false, true])('commutateur=%s', (commutateur) => {
    const d = (commutateur
      ? new CiscoSwitch('switch-cisco', 'SZ')
      : new CiscoRouter('RZ', 0, 0)) as unknown as Cli;
    d.powerOn();
    const shell = (d as unknown as { shell: Record<string, unknown> }).shell;
    const restants = (shell.configTrie as CommandTrie).enumerateExecutablePaths()
      .filter(p => /^(no )?ip (http|domain|dns|domain-list|domain-lookup|domain-name)\b/.test(p));
    expect(restants).toEqual([]);
  });
});
