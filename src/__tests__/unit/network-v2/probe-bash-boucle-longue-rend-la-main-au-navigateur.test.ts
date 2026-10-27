/**
 * `for i in $(seq 1 200); do curl -s -o /dev/null --max-time 5 http://… & done; wait` tournait d'une traite : le simulateur est synchrone (une trame est
 * livree au pair dans l'appel qui l'emet) et le pilote asynchrone du shell (`driveAsync`) n'attendait que des promesses deja resolues, donc toute la boucle
 * s'executait dans UNE tache du navigateur. Mesure dans Chromium sur le laboratoire nat-lab (e2e/nat-lab-stress.spec.ts) : 500 curl = tache longue de 2,9 s,
 * 1000 curl = 8 s (le clavier et le rendu ne repondent plus), trois rafales de 200 = 28 s de blocage.
 *
 * Corrige : `driveAsync` rend la main a la boucle d'evenements (une macrotache, via MessageChannel que les faux timers ne simulent pas) quand sa tranche de
 * 12 ms est depensee, entre deux commandes. La boucle va aussi vite, mais le navigateur peut peindre et lire le clavier entre deux curl.
 *
 * Discrimine par `git stash push -- src/bash` : le cas de la boucle tombe (0 tour de boucle d'evenements pendant les 150 curl, contre plus de 20).
 * Passent des deux cotes, TEMOINS : le resultat de la boucle (le nombre de reponses) et une commande courte qui ne rend jamais la main.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

function countEventLoopTurns(): { stop(): number } {
  let turns = 0;
  const timer = setInterval(() => { turns++; }, 1);
  return { stop: () => { clearInterval(timer); return turns; } };
}

describe('une boucle bash longue rend la main au navigateur', () => {
  it('150 curl a la suite : la boucle d\'evenements tourne pendant la boucle', async () => {
    const lab = await tutoNatLab();
    const turns = countEventLoopTurns();
    const output = await lab.lin.executeCommand('for i in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}\\n" --max-time 5 http://192.168.10.10/ ; done');
    expect(output.split('\n').filter((line) => line === '200').length).toBe(150);
    expect(turns.stop()).toBeGreaterThan(20);
  }, 120_000);

  it('TEMOIN — une commande courte ne rend jamais la main', async () => {
    const lab = await tutoNatLab();
    const turns = countEventLoopTurns();
    expect(await lab.lin.executeCommand('echo bonjour')).toBe('bonjour');
    expect(turns.stop()).toBeLessThan(3);
  });
});
