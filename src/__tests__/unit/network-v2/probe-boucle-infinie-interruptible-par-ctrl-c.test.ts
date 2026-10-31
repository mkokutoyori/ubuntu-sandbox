/**
 * `while true; do :; done` tapé dans un terminal rendait la main au bout de 10000 tours, sans rien dire, alors qu'un vrai
 * bash tourne jusqu'à Ctrl-C : l'interpréteur coupait toute boucle à 10000 itérations (100000 pour `for ((;;))`), même
 * pilotée par un terminal. Le plafond reste là où la boucle ne peut pas rendre la main (substitution de commande,
 * interpréteur synchrone) ; en asynchrone la boucle cède la main à la boucle d'événements tous les 256 tours et Ctrl-C
 * (LinuxMachine.interruptForeground) lève un jeton qu'elle lit : statut 130, l'invite revient.
 *
 * Discriminé par `git stash` sur src/bash et src/network : 3 des 5 cas tombent avant (la boucle ne tourne pas au-delà
 * de 10000 tours, Ctrl-C n'a rien à interrompre, `for ((;;))` s'arrête à 100000). Les 2 qui passent des deux côtés sont des
 * TÉMOINS : une boucle bornée se termine seule, et le plafond d'une substitution de commande synchrone protège toujours
 * l'onglet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const key = (k: string, ctrlKey = false) => ({ key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false });
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const texts = (session: LinuxTerminalSession): string[] => session.lines.map((line) => line.text);

async function type(session: LinuxTerminalSession, text: string, wait = 20): Promise<void> {
  session.setInput(text);
  session.handleKey(key('Enter'));
  await settle(wait);
}

function terminal(): LinuxTerminalSession {
  return new LinuxTerminalSession('t', new LinuxPC('linux-pc', 'PC1'));
}

describe('une boucle shell tourne jusqu à Ctrl-C', () => {
  it('TEMOIN — une boucle bornée se termine seule', async () => {
    const session = terminal();
    await type(session, 'i=0; while [ $i -lt 600 ]; do i=$((i+1)); done; echo done=$i', 200);
    expect(texts(session).join('\n')).toContain('done=600');
  });

  it('while true ne rend pas la main de lui-même', async () => {
    const session = terminal();
    await type(session, 'while true; do :; done; echo ESCAPED$((6*7))', 400);
    expect(texts(session).join('\n')).not.toContain('ESCAPED42');
    session.handleKey(key('c', true));
    await settle(100);
  });

  it('Ctrl-C interrompt while true et l invite revient', async () => {
    const session = terminal();
    await type(session, 'while true; do :; done; echo ESCAPED$((6*7))', 300);
    session.handleKey(key('c', true));
    await settle(200);
    expect(texts(session).join('\n')).toContain('^C');
    await type(session, 'echo AFTER');
    expect(texts(session).join('\n')).toContain('AFTER');
    expect(texts(session).join('\n')).not.toContain('ESCAPED42');
  });

  it('for ((;;)) n est plus coupée à 100000 tours', async () => {
    const session = terminal();
    await type(session, 'n=0; for ((;;)); do n=$((n+1)); ((n>110000)) && break; done; echo reached=$n', 4000);
    expect(texts(session).join('\n')).toContain('reached=110001');
  }, 15000);

  it('TEMOIN — le plafond d une substitution de commande synchrone protège l onglet', async () => {
    const session = terminal();
    await type(session, 'x=$(while true; do :; done); echo survived', 1500);
    expect(texts(session).join('\n')).toContain('survived');
  });
});
