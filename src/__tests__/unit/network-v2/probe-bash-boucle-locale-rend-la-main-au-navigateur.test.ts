/**
 * `for i in $(seq 1 100000); do logger -t stress "message $i"; done` gelait l'onglet : une ligne sans commande reseau prenait le chemin SYNCHRONE
 * (LinuxMachine.executeCommand -> executor.execute), qui ne peut pas rendre la main. Mesure dans Chromium sur nat-lab : l'onglet ne repond plus
 * (la saisie suivante expire apres 10 s), tas a 949 Mo apres 60 s, plus un tour de boucle d'evenements.
 *
 * Corrige : une ligne qui contient for / while / until prend le chemin asynchrone, dont le pilote (driveAsync) rend la main toutes les 12 ms.
 *
 * Discrimine par `git stash push -- src/network/devices/LinuxMachine.ts` : le cas de la boucle tombe (aucun tour de boucle d'evenements
 * pendant les 3000 logger, contre plus de 5). Passent des deux cotes, TEMOINS : le resultat (la derniere valeur de la boucle) et une commande courte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

function countEventLoopTurns(): { stop(): number } {
  let turns = 0;
  const timer = setInterval(() => { turns++; }, 1);
  return { stop: () => { clearInterval(timer); return turns; } };
}

describe('une boucle bash sans commande reseau rend la main au navigateur', () => {
  it('3000 logger a la suite : la boucle d\'evenements tourne pendant la boucle', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const turns = countEventLoopTurns();
    await pc.executeCommand('for i in $(seq 1 3000); do logger -t stress "message $i"; done');
    expect(turns.stop()).toBeGreaterThan(5);
  }, 120_000);

  it('TEMOIN — la boucle fait tous ses tours', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const output = await pc.executeCommand('for i in 1 2 3; do echo tour$i; done');
    expect(output.split('\n')).toEqual(['tour1', 'tour2', 'tour3']);
  });

  it('TEMOIN — une commande courte ne rend jamais la main', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const turns = countEventLoopTurns();
    expect(await pc.executeCommand('echo bonjour')).toBe('bonjour');
    expect(turns.stop()).toBeLessThan(3);
  });
});
