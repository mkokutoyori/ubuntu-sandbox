/**
 * Une plage annoncee par `?` peut dependre de l'ETAT de la session.
 *
 * Mesure de depart : la borne du numero de groupe HSRP vaut 0-255 en
 * version 1 et 0-4095 en version 2. Le gestionnaire l'appliquait
 * correctement et dynamiquement ; l'aide, elle, annoncait toujours
 * `<0-255>`. Sur une interface passee en `standby version 2`, la machine
 * acceptait donc le groupe 300 en disant, au meme instant, que le
 * maximum est 255.
 *
 * Discrimination par `git stash` : UN seul des six cas tombe, et c'est
 * exact — le defaut etait unique. Les cinq autres sont nommes plutot que
 * laisses a decouvrir, et chacun a sa raison de passer des deux cotes :
 * le TEMOIN et « revenir en version 1 » lisent la plage STATIQUE, qui
 * etait deja juste ; « la machine accepte alors le groupe » eprouve le
 * gestionnaire, qui etait deja juste lui aussi — c'est justement ce qui
 * fait que seule l'aide mentait ; et les deux NON-REGRESSION gardent ce
 * que ce lot ne devait pas deranger, la plage fixe et les valeurs
 * vivantes, qui passent par la MEME porte (`EquipmentParamResolver`).
 *
 * Ce que ce lot ne fait PAS, et c'est deliberé : la regle « une plage
 * annoncee est appliquee » ne prend pas la main sur ce groupe. Le
 * gestionnaire refuse deja, et il le fait avec les mots d'IOS
 * (`% Group number out of range...`) la ou la regle rendrait le caret
 * generique. Deux refus pour une saisie seraient un refus de trop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

interface Cli {
  executeCommand(c: string): Promise<string> | string;
  cliHelp(s: string): string;
}

async function surUneInterface(): Promise<Cli> {
  const r = new CiscoRouter('R1') as unknown as Cli;
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  return r;
}

describe('HSRP : `standby ?` annonce la plage de la VERSION configuree', () => {
  it('TEMOIN — en version 1, l\'aide annonce <0-255> et 300 est refuse', async () => {
    const r = await surUneInterface();

    expect(r.cliHelp('standby ')).toContain('<0-255>');
    expect(await r.executeCommand('standby 300 ip 10.0.0.1'))
      .toContain('Valid range is 0-255 for HSRP version 1');
  });

  it('en version 2, l\'aide annonce <0-4095>', async () => {
    const r = await surUneInterface();
    await r.executeCommand('standby version 2');

    expect(r.cliHelp('standby ')).toContain('<0-4095>');
    expect(r.cliHelp('standby ')).not.toContain('<0-255>');
  });

  it('et la machine accepte alors le groupe que son aide annonce', async () => {
    const r = await surUneInterface();
    await r.executeCommand('standby version 2');

    expect(await r.executeCommand('standby 300 ip 10.0.0.1')).toBe('');
    expect(await r.executeCommand('standby 4096 ip 10.0.0.2'))
      .toContain('Valid range is 0-4095 for HSRP version 2');
  });

  it('revenir en version 1 ramene l\'aide a <0-255>', async () => {
    const r = await surUneInterface();
    await r.executeCommand('standby version 2');
    await r.executeCommand('standby version 1');

    expect(r.cliHelp('standby ')).toContain('<0-255>');
  });

  it('NON-REGRESSION — une plage qui ne depend de rien reste annoncee telle quelle', async () => {
    const r = new CiscoRouter('R1') as unknown as Cli;
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');

    expect(r.cliHelp('ip ssh time-out ')).toContain('<1-120>');
    expect(await r.executeCommand('ip ssh time-out 121')).toContain('Invalid input');
  });

  it('NON-REGRESSION — les valeurs VIVANTES restent proposees par la meme porte', async () => {
    const r = new CiscoRouter('R1') as unknown as Cli;
    await r.executeCommand('enable');

    expect(r.cliHelp('show ip interface G')).toContain('GigabitEthernet0/0');
  });
});
