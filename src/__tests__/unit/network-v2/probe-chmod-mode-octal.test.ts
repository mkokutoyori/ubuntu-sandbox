/**
 * `chmod` lit un mode OCTAL, et un mode invalide ne touche pas au fichier.
 *
 * Mesure de depart : le mode numerique etait reconnu par `/^\d{3,4}$/` —
 * des chiffres DECIMAUX — puis converti par `parseInt(modeStr, 8)`.
 * `chmod 999 f` donnait donc `NaN`, et le fichier passait de
 * `-rw-r--r--` a `----------` sans un mot : une faute de frappe retirait
 * TOUTES les permissions au lieu d'etre refusee.
 *
 * La meme expression etait trop STRICTE dans l'autre sens : `chmod 7`,
 * `chmod 0` et `chmod 00644`, toutes valides sur une vraie machine,
 * repondaient `invalid mode`.
 *
 * Trouve en ecrivant la sonde, et corrige avec : `formatOctalPermissions`
 * remplissait a TROIS chiffres pour ses deux appelants, qui n'en veulent
 * pas le meme nombre. `stat -c %a` ne remplit pas du tout sur une vraie
 * machine (`7`, pas `007`) et la forme longue remplit a QUATRE
 * (`Access: (0644/…)`, pas `(644/…)`). La largeur appartient donc a
 * l'appelant, pas a la fonction.
 *
 * Discrimination par `git stash` : 8 des 10 cas tombent avant
 * correctif. Le TEMOIN (`chmod 755`, qui a toujours marche) et le cas de
 * NON-REGRESSION du mode symbolique passent des deux cotes, et c'est
 * leur objet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function machine(): Promise<LinuxPC> {
  const pc = new LinuxPC('PC1');
  pc.powerOn();
  await pc.executeCommand('touch /tmp/f');
  await pc.executeCommand('chmod 644 /tmp/f');
  return pc;
}

const mode = async (pc: LinuxPC): Promise<string> =>
  (await pc.executeCommand('stat -c %a /tmp/f')).trim();

describe('chmod : le mode numerique est OCTAL', () => {
  it('TEMOIN — un mode ordinaire s\'applique', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod 755 /tmp/f')).toBe('');
    expect(await mode(pc)).toBe('755');
  });

  it('un chiffre non octal est refuse', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod 999 /tmp/f'))
      .toBe("chmod: invalid mode: '999'");
  });

  it('et le fichier garde ses permissions', async () => {
    const pc = await machine();
    await pc.executeCommand('chmod 999 /tmp/f');

    expect(await mode(pc)).toBe('644');
  });

  it('quatre chiffres non octaux sont refuses aussi', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod 8888 /tmp/f'))
      .toBe("chmod: invalid mode: '8888'");
    expect(await mode(pc)).toBe('644');
  });

  it('un mode d\'UN chiffre est valide', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod 7 /tmp/f')).toBe('');
    expect(await pc.executeCommand('ls -l /tmp/f')).toContain('-------rwx');
  });

  it('`chmod 0` retire tout, et c\'est une commande valide', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod 0 /tmp/f')).toBe('');
    expect(await pc.executeCommand('ls -l /tmp/f')).toContain('----------');
  });

  it('`stat -c %a` ne remplit pas de zeros, la forme longue en met quatre', async () => {
    const pc = await machine();
    await pc.executeCommand('chmod 7 /tmp/f');

    expect(await mode(pc)).toBe('7');
    expect(await pc.executeCommand('stat /tmp/f')).toContain('Access: (0007/');
  });

  it('les zeros de tete sont de l\'octal, pas une faute', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod 00644 /tmp/f')).toBe('');
    expect(await mode(pc)).toBe('644');
  });

  it('le mode est juge AVANT la cible', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod 999 /tmp/absent'))
      .toBe("chmod: invalid mode: '999'");
  });

  it('NON-REGRESSION — le mode symbolique passe par le meme parseur', async () => {
    const pc = await machine();

    expect(await pc.executeCommand('chmod u+x,go-r /tmp/f')).toBe('');
    expect(await mode(pc)).toBe('700');
    expect(await pc.executeCommand('chmod zorglub /tmp/f'))
      .toBe("chmod: invalid mode: 'zorglub'");
  });
});
