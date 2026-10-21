/**
 * Un script lance par son chemin (`echo x | ./s.sh`) ou par `bash s.sh` recoit l'entree standard de son tube ;
 * `read` et `cat` la lisent. Avant, l'entree n'etait transmise qu'a `bash -c` : un script de fichier lisait un
 * flux vide et `while read line` ne tournait jamais.
 *
 * Mesure avant : l'entree n'etait lue que par les commandes (`cat`) et par les boucles du meme script ; ni `bash -c`
 * ni un script de fichier ne la transmettaient a `read`. Avec src/network et src/bash remis avant, 4 cas sur 5
 * tombent, temoin compris (le tube vers `bash -c` etait vide) ; « sans tube, read rend un flux vide » passe dans les
 * deux etats et borne les quatre cas qui lisent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function host(): Promise<LinuxPC> {
  const pc = new LinuxPC('ScriptHost', 0, 0);
  await pc.executeCommand('sudo su -');
  await pc.executeCommand('printf \'#!/bin/bash\\nwhile read line; do echo "got $line"; done\\n\' > /tmp/loop.sh && chmod 755 /tmp/loop.sh');
  return pc;
}

describe('script standard input', () => {
  it('witness: bash -c reads the pipe', async () => {
    const pc = await host();
    expect(await pc.executeCommand('printf "a\\nb\\n" | bash -c \'while read line; do echo "got $line"; done\'')).toBe('got a\ngot b');
  });

  it('a script run by path reads the pipe line by line', async () => {
    const pc = await host();
    expect(await pc.executeCommand('printf "a\\nb\\n" | /tmp/loop.sh')).toBe('got a\ngot b');
  });

  it('a script run through bash reads the pipe', async () => {
    const pc = await host();
    expect(await pc.executeCommand('printf "c\\n" | bash /tmp/loop.sh')).toBe('got c');
  });

  it('a script that redirects what it reads writes it to its file', async () => {
    const pc = await host();
    await pc.executeCommand('printf \'#!/bin/bash\\nwhile read line; do echo "$line" >> /tmp/out.log; done\\n\' > /tmp/save.sh && chmod 755 /tmp/save.sh');
    await pc.executeCommand('printf "x\\ny\\n" | /tmp/save.sh');
    expect(await pc.executeCommand('cat /tmp/out.log')).toBe('x\ny');
  });

  it('without a pipe, read gets an empty stream and the loop does not run', async () => {
    const pc = await host();
    expect(await pc.executeCommand('/tmp/loop.sh')).toBe('');
  });
});
