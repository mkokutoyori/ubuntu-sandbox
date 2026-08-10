/**
 * Une commande qui MARCHE doit se laisser DÉCOUVRIR.
 *
 * Signalé par l'utilisateur : `service password-encryption` fonctionnait
 * sur le switch sans être proposé ni par `?` ni par Tab. L'audit a
 * trouvé deux causes distinctes, et la seconde couvrait toute une
 * classe.
 *
 * 1. **La commande n'était déclarée nulle part sur le switch.** Elle
 *    était avalée par le gestionnaire générique `service <mot>`, qui
 *    accepte n'importe quoi et pose un drapeau : elle marchait donc,
 *    sans nœud dans l'arbre, donc sans aide. Elle vit maintenant dans la
 *    famille identité, que les deux plateformes enregistrent.
 * 2. **`describeCiscoArguments` n'était posée que sur le shell du
 *    ROUTEUR.** IOS ne nomme pas ses arguments, il les TYPE : un
 *    Catalyst répondait `WORD  Set a banner` là où IOS liste `motd`,
 *    `login`, `exec`, `incoming`. Toute la table est désormais lue par
 *    les deux shells — c'était une lacune déclarée dans `CLAUDE.md`,
 *    fermée ici.
 *
 * Deux trous trouvés en la posant : `banner ?` ne connaissait QUE
 * `motd`, et `crypto key generate rsa ?` ne répondait que `<cr>` alors
 * que la commande consomme `modulus`, `label`, `usage-keys` et
 * `general-keys`.
 *
 * Ce fichier est un GARDE-FOU, pas une liste de cas : il vérifie la
 * règle « accepté ⇒ proposé », qui est ce qui a manqué.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  EquipmentRegistry.resetInstance(); Logger.clear();
});

type Machine = CiscoSwitch | CiscoRouter;
const PLATEFORMES: Array<[string, () => Machine]> = [
  ['switch', () => new CiscoSwitch('SW1')],
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
];

/** Les mots-clés que `?` propose après `prefixe`. */
function proposes(d: Machine, prefixe: string): Set<string> {
  return new Set(d.cliHelp(prefixe).split('\n')
    .map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
}

/** Les candidats que Tab retient pour `saisie`. */
function tab(d: Machine, saisie: string): string[] {
  return (d as unknown as { cliTabCandidates?: (s: string) => string[] })
    .cliTabCandidates?.(saisie) ?? [];
}

/** Chemins dont chaque mot-clé doit être proposé au niveau de son parent. */
const CHEMINS: string[] = [
  'service password-encryption',
  'service timestamps debug',
  'service timestamps log',
  'security passwords min-length',
  'aaa new-model',
  'aaa authentication login',
  'aaa authorization exec',
  'aaa accounting exec',
  'login block-for',
  'login on-failure',
  'banner motd',
  'banner login',
  'banner exec',
  'banner incoming',
  'crypto key generate rsa',
  'ip ssh version',
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — accepté implique proposé`, () => {
    async function enConfig(): Promise<Machine> {
      const d = fabrique();
      d.powerOn();
      await d.executeCommand('enable');
      await d.executeCommand('configure terminal');
      return d;
    }

    it('chaque mot-clé est proposé par `?` au niveau de son parent', async () => {
      const d = await enConfig();
      for (const chemin of CHEMINS) {
        const mots = chemin.split(' ');
        for (let i = 0; i < mots.length; i++) {
          const parent = mots.slice(0, i).join(' ');
          const offert = proposes(d, parent ? `${parent} ` : '');
          expect(offert, `"${mots[i]}" après "${parent}" (${chemin})`).toContain(mots[i]);
        }
      }
    }, 60_000);

    /**
     * `?` et Tab doivent lire la MÊME règle. Les laisser diverger est le
     * défaut que l'utilisateur avait déjà signalé une fois : une
     * commande disparue des suggestions restait complétée par Tab.
     */
    it('Tab retient les mêmes mots-clés que `?`', async () => {
      const d = await enConfig();
      for (const [saisie, attendu] of [
        ['service pass', 'password-encryption'],
        ['banner mo', 'motd'],
        ['banner inc', 'incoming'],
        ['aaa authentication lo', 'login'],
        ['crypto key generate rsa mod', 'modulus'],
        ['service timestamps de', 'debug'],
      ] as const) {
        const cands = tab(d, saisie);
        expect(cands.length, `Tab ne propose rien pour "${saisie}"`).toBeGreaterThan(0);
        expect(cands.some((c) => c.includes(attendu)), `"${saisie}" → ${attendu}`).toBe(true);
      }
    }, 60_000);

    it('et la commande complète est bien ACCEPTÉE — sinon on décrirait un mirage', async () => {
      const d = await enConfig();
      await d.executeCommand('ip domain-name lab.local');
      for (const [cmd] of [
        ['service password-encryption'], ['service timestamps log datetime'],
        ['security passwords min-length 8'], ['banner exec #X#'],
        ['banner incoming #Y#'], ['crypto key generate rsa modulus 1024'],
      ] as const) {
        expect(await d.executeCommand(cmd), cmd).not.toContain('% Invalid input');
      }
    }, 60_000);
  });
}
