/**
 * Ecrit depuis la reference IOS fournie, avant toute lecture du code.
 *
 * La methode de repartition d'un agregat se configure au niveau GLOBAL,
 * pour tout le commutateur, et `?` en enumere les sept valeurs :
 *
 *     Switch-A(config)#port-channel load-balance src-dst-ip
 *     Switch-A(config)#port-channel load-balance ?
 *       dst-ip         IP destination
 *       dst-mac        MAC destination
 *       src-dst-ip     IPs source + destination
 *       src-dst-mac    MACs source + destination
 *       src-dst-port   IPs + ports source + destination
 *       src-ip         IP source
 *       src-mac        MAC source
 *
 * Ce que la sonde verifie : les sept valeurs sont ACCEPTEES, une
 * huitieme est refusee, la valeur se relit dans la configuration — qui
 * est rejouee a l'import d'une topologie —, `show etherchannel
 * load-balance` la rend, et surtout `?` les ANNONCE. Une valeur qu'on
 * peut taper et que l'aide tait est introuvable autrement que par la
 * documentation, ce qui est exactement ce que `?` existe pour eviter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
}

const METHODES = [
  'dst-ip', 'dst-mac', 'src-dst-ip', 'src-dst-mac',
  'src-dst-port', 'src-ip', 'src-mac',
] as const;

let serie = 0;

async function enConfig(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', `SW${serie++}`, 8, 0, 0) as unknown as Cli;
  (s as unknown as { powerOn(): void }).powerOn();
  for (const c of ['enable', 'configure terminal']) await s.executeCommand(c);
  return s;
}

const config = async (d: Cli): Promise<string> => {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
};

describe('les sept methodes sont acceptees', () => {
  it.each(METHODES)('`port-channel load-balance %s`', async (methode) => {
    const s = await enConfig();

    expect(await s.executeCommand(`port-channel load-balance ${methode}`))
      .not.toMatch(/Invalid input|Incomplete command/);
  });

  it('une huitieme est refusee', async () => {
    const s = await enConfig();

    expect(await s.executeCommand('port-channel load-balance zorglub'))
      .toMatch(/Invalid input/);
  });

  it('et sans methode, la commande est incomplete', async () => {
    const s = await enConfig();

    expect(await s.executeCommand('port-channel load-balance'))
      .toMatch(/Incomplete command/);
  });
});

describe('`?` ANNONCE les sept methodes', () => {
  it('chacune y figure avec une description', async () => {
    const s = await enConfig();
    const aide = s.cliHelp('port-channel load-balance ');

    for (const methode of METHODES) {
      expect(aide, methode).toMatch(new RegExp(`^\\s+${methode}\\s+\\S`, 'm'));
    }
  });

  it('et rien d autre n y figure', async () => {
    const s = await enConfig();
    const offerts = s.cliHelp('port-channel load-balance ').split('\n')
      .map(l => l.trim().split(/\s{2,}/)[0])
      .filter(m => m.length > 0 && m !== '<cr>');

    expect(offerts.sort()).toEqual([...METHODES].sort());
  });
});

describe('la methode choisie se relit', () => {
  it('la configuration la rend', async () => {
    const s = await enConfig();
    await s.executeCommand('port-channel load-balance src-dst-ip');

    expect(await config(s)).toMatch(/^port-channel load-balance src-dst-ip$/m);
  });

  it('`show etherchannel load-balance` la rend aussi', async () => {
    const s = await enConfig();
    await s.executeCommand('port-channel load-balance src-dst-port');
    await s.executeCommand('end');

    expect(await s.executeCommand('show etherchannel load-balance'))
      .toContain('src-dst-port');
  });

  it('la derniere tapee remplace la precedente', async () => {
    const s = await enConfig();
    await s.executeCommand('port-channel load-balance src-mac');
    await s.executeCommand('port-channel load-balance dst-ip');
    const vue = await config(s);

    expect(vue).toMatch(/^port-channel load-balance dst-ip$/m);
    expect(vue).not.toContain('src-mac');
  });
});
