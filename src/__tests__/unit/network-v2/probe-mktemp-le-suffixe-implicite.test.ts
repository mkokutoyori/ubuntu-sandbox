/**
 * Sonde — `mktemp` accepte un modèle qui ne finit pas par X : ce qui suit le dernier X est un suffixe implicite (coreutils : « --suffix=SUFF ...
 * cette option est implicite si TEMPLATE ne finit pas par X »), et il faut au moins trois X avant lui.
 *
 * Mesure d'origine : le portage de mktemp comptait les X de FIN de modèle seulement, donc `mktemp /tmp/cisco-config-XXXXX.txt` répondait
 * « too few X's in template » et `CONFIG_FILE=$(mktemp ...)` restait vide (scenario-bash-heredoc-cisco-config, balayage complet).
 *
 * Discrimination `git stash` : 3 cas tombent avant le correctif — « an implicit suffix is kept », « the suffix is applied to a directory
 * template too » et « a slash in the implicit suffix is refused ».
 *
 * Passent des deux côtés, et pourquoi :
 *  - « TEMOIN: a template ending in X is expanded » — le cas que le portage savait déjà.
 *  - « too few X's » — NON-RÉGRESSION : le refus de moins de trois X reste.
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

describe('Probe — mktemp templates', () => {
  it('TEMOIN: a template ending in X is expanded', async () => {
    expect(await run('mktemp /tmp/probe.XXXXXX')).toMatch(/^\/tmp\/probe\.[A-Za-z0-9]{6}$/);
  });

  it('an implicit suffix is kept', async () => {
    expect(await run('mktemp /tmp/cisco-config-XXXXX.txt')).toMatch(/^\/tmp\/cisco-config-[A-Za-z0-9]{5}\.txt$/);
  });

  it('the suffix is applied to a directory template too', async () => {
    const path = await run('d=$(mktemp -d /tmp/dir-XXXXXX.d); echo "$d"; test -d "$d" && echo isdir');
    expect(path).toMatch(/^\/tmp\/dir-[A-Za-z0-9]{6}\.d\nisdir$/);
  });

  it('a slash in the implicit suffix is refused', async () => {
    expect(await run('mktemp /tmp/aXXXXXX/b; echo rc=$?')).toContain("invalid suffix '/b', contains directory separator");
  });

  it("too few X's is refused", async () => {
    expect(await run('mktemp /tmp/aXX; echo rc=$?')).toBe("mktemp: too few X's in template '/tmp/aXX'\nrc=1");
  });
});
