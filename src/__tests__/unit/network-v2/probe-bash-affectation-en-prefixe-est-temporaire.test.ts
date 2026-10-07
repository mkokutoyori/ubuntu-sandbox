/**
 * `VAR=valeur commande` pose `VAR` pour cette commande SEULE : bash la retire (ou la remet a sa
 * valeur d'avant) quand la commande finit. L'interpreteur l'ecrivait dans l'environnement du
 * shell et ne la retirait jamais.
 *
 * MESURE : `FOO=bar env | grep FOO` voit bien `FOO=bar`, puis `echo "[$FOO]"` rend `[bar]` ;
 * `TZ=Asia/Tokyo date +%Z` rend `JST`, et le `date +%Z` suivant rend `JST` aussi — le fuseau d'une
 * commande devenait celui de toute la session. Corrige : l'affectation en prefixe est sauvee puis
 * restauree (`Environment.snapshotVariable` / `restoreVariable`), y compris quand la commande est
 * une fonction ou echoue. Les declarations (`export`, `readonly`, `local`) gardent leur effet.
 *
 * Discriminee contre l'etat d'avant : 5 des 7 cas tombent. Passent des deux cotes, NOMMES : le
 * temoin « la commande voit le prefixe » et « une affectation seule persiste ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let server: LinuxServer;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); Logger.reset();
  server = new LinuxServer('linux-server', 'S1');
});

const run = async (command: string) => (await server.executeCommand(command)).trim();

describe('a prefix assignment lives for one command', () => {
  it('witness: the command sees the prefix', async () => {
    expect(await run('FOO=bar env | grep FOO')).toBe('FOO=bar');
  });

  it('is gone once the command has run', async () => {
    await server.executeCommand('FOO=bar env');
    expect(await run('echo "[$FOO]"')).toBe('[]');
  });

  it('puts back the previous value of a variable that was already set', async () => {
    await server.executeCommand('FOO=3');
    await server.executeCommand('FOO=4 true');
    expect(await run('echo "[$FOO]"')).toBe('[3]');
  });

  it('is seen by a function and gone after it', async () => {
    expect(await run('f() { echo "in:$FOO"; }; FOO=6 f; echo "after:[$FOO]"')).toBe('in:6\nafter:[]');
  });

  it('witness: an assignment alone persists', async () => {
    await server.executeCommand('FOO=3');
    expect(await run('echo "[$FOO]"')).toBe('[3]');
  });

  it('does not turn the zone of one command into the zone of the session', async () => {
    expect(await run('TZ=Asia/Tokyo date +%Z')).toBe('JST');
    expect(await run('date +%Z')).toBe('UTC');
  });

  it('keeps the effect of export', async () => {
    await server.executeCommand('export BAR=1');
    expect(await run('BAR=2 env | grep BAR')).toBe('BAR=2');
    expect(await run('echo "[$BAR]"')).toBe('[1]');
  });
});
