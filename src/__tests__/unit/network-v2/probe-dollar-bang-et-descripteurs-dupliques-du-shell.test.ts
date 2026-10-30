/**
 * Sonde — `$!` d'un pipeline lancé en arrière-plan, et `exec N>&M`.
 *
 * Mesure d'origine (corpus nc-1.226 et umask-bash-5.2 rejoué sur mandeng) :
 *  - `echo hi | nc -q 1 127.0.0.1 9004 & C=$!` laissait `$!` au pid du travail précédent : chaque étage d'un tube tourne maintenant dans un
 *    environnement fils, et le pid enregistré par le dernier étage lancé en arrière-plan mourait avec lui. Bash donne à `$!` le pid du dernier
 *    processus du tube ;
 *  - `exec 3>&1; umask -S >&3` répondait `3: Bad file descriptor` : l'interpréteur ignorait la duplication d'un descripteur de sortie vers un
 *    descripteur supérieur à 2 (seuls `exec 3>fichier` et `exec 3>&-` étaient traités).
 *
 * Discrimination `git stash` : 4 cas tombent avant le correctif — « $! names the last process of a background pipeline », « exec 3>&1 gives
 * descriptor 3 the standard output », « exec 4>&3 copies a descriptor » et « exec 3>&9 refuses a descriptor that is not open » (avant, la
 * duplication était ignorée sans message).
 *
 * Passe des deux côtés, et pourquoi :
 *  - « $! names a simple background command » — TÉMOIN : `$!` d'une commande simple, le cas que le tube ne devait pas casser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function run(command: string): Promise<string> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc.executeCommand(command);
}

describe('Probe — $! of a background command', () => {
  it('$! names a simple background command', async () => {
    const output = await run('sleep 100 & P=$!; ps -p $P -o comm=');
    expect(output).toContain('sleep');
  });

  it('$! names the last process of a background pipeline', async () => {
    const output = await run('sleep 100 & F=$!; echo hi | sleep 200 & L=$!; test "$F" != "$L" && echo different');
    expect(output.split('\n').pop()).toBe('different');
  });
});

describe('Probe — exec N>&M', () => {
  it('exec 3>&1 gives descriptor 3 the standard output', async () => {
    expect(await run('exec 3>&1; echo through3 >&3')).toBe('through3');
  });

  it('exec 4>&3 copies a descriptor', async () => {
    expect(await run('exec 3>&1; exec 4>&3; echo through4 >&4')).toBe('through4');
  });

  it('exec 3>&9 refuses a descriptor that is not open', async () => {
    expect(await run('exec 3>&9; echo rc=$?')).toContain('Bad file descriptor');
  });
});
