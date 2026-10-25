/**
 * `ping 203.0.113.1 repeat 3000` sur un routeur Cisco tournait d'une traite : mesure dans Chromium (nat-lab, e2e/nat-lab-stress.spec.ts
 * cisco-ping-repeat-3000) = UNE tache longue de 4,4 s, 3,2 s pour 2000 sondes avec `debug ip packet`. La boucle de Router.executePingSequence n'attendait que
 * des promesses deja resolues (la livraison des trames est synchrone). Elle rend maintenant la main a la boucle d'evenements quand sa tranche de
 * 12 ms est depensee (events/CooperativeYield, le meme mecanisme que la boucle bash) ; EndHost.pingEach (Linux et Windows) et SwitchSvi font de meme.
 *
 * Discrimine par `git stash push -- src/network` : le cas du routeur tombe (aucun tour de boucle d'evenements pendant les 1500 sondes, contre plus de 5).
 * Passent des deux cotes, TEMOINS : le nombre de sondes recues et le ping court.
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

describe('un ping Cisco en rafale rend la main au navigateur', () => {
  it('1500 sondes : la boucle d\'evenements tourne pendant le ping', async () => {
    const lab = await tutoNatLab();
    await lab.r.executeCommand('enable');
    const turns = countEventLoopTurns();
    const output = await lab.r.executeCommand('ping 203.0.113.1 repeat 1500');
    expect(output).toContain('Success rate is 100 percent (1500/1500)');
    expect(turns.stop()).toBeGreaterThan(5);
  }, 120_000);

  it('TEMOIN — cinq sondes courtes ne rendent jamais la main', async () => {
    const lab = await tutoNatLab();
    await lab.r.executeCommand('enable');
    const turns = countEventLoopTurns();
    expect(await lab.r.executeCommand('ping 203.0.113.1')).toContain('Success rate is 100 percent (5/5)');
    expect(turns.stop()).toBeLessThan(3);
  });
});
