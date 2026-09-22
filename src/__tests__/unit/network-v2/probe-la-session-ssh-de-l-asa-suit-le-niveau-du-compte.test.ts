/*
 * La session SSH d'un ASA s'ouvrait dans un mode a DEUX mots.
 *
 * Mesure de depart, sur un ASA ou l'on declare `username admin password
 * ... privilege 15` et ou l'on autorise SSH depuis le LAN :
 *
 *   console          show version        Cisco Adaptive Security Appliance...
 *   ssh admin@asa    "show version"      % Invalid input detected at '^' marker.
 *   ssh admin@asa    "show running-config"  % Invalid input detected ...
 *
 * La MEME machine, au MEME instant, repond deux choses a la meme
 * commande selon la porte. La cause n'est pas le vocabulaire : c'est le
 * MODE dans lequel la session s'ouvre. `ASA_VOCABULARY.exec` ne porte
 * que `enable` et `exit` — et une commande distante d'un seul coup ne
 * peut pas taper `enable` puis autre chose.
 *
 * L'AUTORITE EST CISCO, pas un RFC : le modele de privilege de l'ASA
 * est le sien. Le guide de configuration (ASA Series General Operations,
 * « Management Access ») dit que l'ASA place l'utilisateur authentifie
 * au niveau de privilege que la base locale lui donne, et que donner a
 * un compte un niveau de 2 a 15 lui ouvre le mode EXEC privilegie des
 * l'ouverture de session, sans second `enable`.
 *
 * `createManagementCli(user, origin)` recevait pourtant le nom du
 * compte et l'ignorait (`void user;`) : chaque session repartait d'une
 * coquille neuve en mode utilisateur, quel que soit le compte. Elle lit
 * desormais le profil de l'administrateur — celui que `username ...
 * privilege 15` a deja range — et ouvre au bon mode.
 *
 * CE QUE CE LOT NE MESURE PAS, et le dit plutot que de le deviner :
 * l'AUTORISATION de commandes par niveau (`aaa authorization exec`,
 * `privilege level` par commande) n'est pas modelisee ici. La sonde ne
 * prononce donc rien sur ce qu'un compte de niveau intermediaire peut
 * taper ; elle mesure le niveau 15, qui est le cas documente sans
 * ambiguite.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire la coquille.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 3 des 5 cas tombent. Les 2 autres sont nommes ici :
 *
 *  - TEMOIN DE LA CONSOLE : la meme commande y rend sa banniere des
 *    DEUX cotes. C'est lui qui designe la cause comme etant la PORTE et
 *    non la commande.
 *  - TEMOIN DE LA PORTE SSH : la session s'ouvre et la CLI repond
 *    quelque chose des deux cotes. Sans lui, « SSH ne joint pas l'ASA »
 *    et « SSH le joint dans le mauvais mode » seraient indiscernables.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { createDevice } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ASA_IP = '10.0.10.2';
const POSTE_IP = '10.0.10.9';
const SECRET = 'Admin@123';

interface Cli { executeCommand(c: string, s?: string): Promise<string> }

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(): Promise<{ asa: Cli; poste: LinuxPC }> {
  const asa = createDevice('firewall-cisco', 0, 0) as unknown as Cli & {
    powerOn(): void; getPorts(): Array<{ getName(): string }>;
  };
  const poste = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  asa.powerOn(); poste.powerOn(); sw.powerOn();

  const portAsa = (asa as unknown as { getPorts(): unknown[] }).getPorts()[0];
  new Cable('c1').connect(portAsa as never, sw.getPorts()[0]);
  new Cable('c2').connect(poste.getPort('eth0')!, sw.getPorts()[1]);

  const nom = (portAsa as { getName(): string }).getName();
  for (const c of [
    'enable',
    'configure terminal',
    `interface ${nom}`,
    'nameif inside',
    'security-level 100',
    `ip address ${ASA_IP} 255.255.255.0`,
    'no shutdown',
    'exit',
    `username admin password ${SECRET} privilege 15`,
    'ssh 10.0.10.0 255.255.255.0 inside',
    'crypto key generate rsa modulus 2048',
    'end',
  ]) await asa.executeCommand(c);

  await poste.executeCommand(`ifconfig eth0 ${POSTE_IP} netmask 255.255.255.0`);
  return { asa, poste };
}

const parSsh = (poste: LinuxPC, commande: string): Promise<string> =>
  poste.executeCommand(`ssh admin@${ASA_IP} "${commande}"`, `${SECRET}\n`);

describe('la console repond — le TEMOIN', () => {
  it('`show version` y rend la banniere de l\'ASA', async () => {
    const { asa } = await laboratoire();

    expect(await asa.executeCommand('show version')).toMatch(/Adaptive Security|ASA|Version/i);
  });
});

describe('la porte SSH joint l\'ASA — le TEMOIN', () => {
  it('la session s\'ouvre et la CLI repond quelque chose', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show version')).not.toMatch(/Permission denied|refused/i);
  });
});

describe('la session SSH d\'un compte de niveau 15 ouvre en EXEC privilegie', () => {
  it('`show version` y rend la meme banniere que la console', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show version')).toMatch(/Adaptive Security|ASA|Version/i);
  });

  it('et ne repond plus `% Invalid input`', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show version')).not.toMatch(/Invalid input/);
  });

  it('`show running-config` y rend la configuration', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show running-config')).toMatch(/username admin|interface|hostname/i);
  });
});
