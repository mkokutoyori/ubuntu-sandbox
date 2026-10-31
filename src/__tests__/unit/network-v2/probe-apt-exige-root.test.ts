/**
 * apt-get / apt (Ubuntu 24.04) : install, remove, purge, upgrade... exigent root ; sans root « E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied) » puis « E: Unable to acquire ... are you root? », code 100 ; -s laisse passer ; sorties relevées sur le apt-get réel de cette machine lancé en tant que nobody.
 * Mesure de départ : un utilisateur ordinaire installait un paquet sans sudo. 4 des 6 cas tombent avant ; passent dans les deux états : sudo apt install (témoin) et apt list.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

const REFUSAL = 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?';

describe('apt exige root', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });
  const run = (command: string): Promise<string> => pc.executeCommand(command);

  it('apt-get install sans root', async () => { expect(await run('apt-get install nginx; echo rc=$?')).toBe(`${REFUSAL}\nrc=100`); });
  it('apt install sans root', async () => { expect(await run('apt install nginx; echo rc=$?')).toBe(`${REFUSAL}\nrc=100`); });
  it('apt-get remove sans root', async () => { expect(await run('apt-get remove nginx; echo rc=$?')).toBe(`${REFUSAL}\nrc=100`); });
  it('le paquet n\'est pas posé', async () => {
    await run('apt-get install nginx');
    expect(await run('dpkg -l nginx 2>&1 | grep -c "^ii"')).toBe('0');
  });
  it('témoin : sudo apt install', async () => { expect(await run('sudo apt install -y nginx | tail -1')).toContain('Setting up nginx'); });
  it('apt list --installed reste permis', async () => { expect(await run('apt list --installed | head -1')).toBe('Listing... Done'); });
});
