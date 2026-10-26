/**
 * `nmap -p- 203.0.113.2` lance depuis EXT tournait d'une traite : mesure dans Chromium (nat-lab, e2e/nat-lab-stress.spec.ts ext-nmap-router) = UNE tache
 * longue de 7,3 s. La boucle de ScanEngine.scanHost sondait chaque port de facon synchrone (la livraison des trames l'est). Elle rend maintenant la
 * main quand sa tranche de 12 ms est depensee (events/CooperativeYield).
 *
 * Discrimine par `git stash push -- src/network/scan` : le cas du balayage tombe (un seul tour de boucle d evenements pendant les 8000 ports, contre plus de 5).
 * Passent des deux cotes, TEMOINS : la liste des ports ouverts et un balayage court.
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

describe('un balayage nmap long rend la main au navigateur', () => {
  it('8000 ports : la boucle d\'evenements tourne pendant le balayage', async () => {
    const lab = await tutoNatLab();
    const turns = countEventLoopTurns();
    const output = await lab.ext.executeCommand('nmap -p 1-8000 192.168.10.10');
    expect(output).toContain('80/tcp');
    expect(turns.stop()).toBeGreaterThan(5);
  }, 120_000);

  it('TEMOIN — un balayage court liste le port 80 ouvert', async () => {
    const lab = await tutoNatLab();
    expect(await lab.lin.executeCommand('nmap -p 80,81 192.168.10.10')).toMatch(/80\/tcp\s+open/);
  });
});
