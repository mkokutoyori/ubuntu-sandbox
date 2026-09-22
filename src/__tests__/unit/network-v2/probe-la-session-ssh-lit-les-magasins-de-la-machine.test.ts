/*
 * Une session SSH recevait un ROUTEUR NEUF a chaque ouverture.
 *
 * `Router.createVtyShell()` fabrique une coquille par session — c'est
 * juste : le mode, le niveau de privilege, l'historique et la vue de
 * l'analyseur appartiennent a la LIGNE. Mais `CiscoShellBase` porte
 * aussi deux magasins qui appartiennent a la MACHINE, et chaque
 * coquille s'en fabriquait les siens :
 *
 *     protected readonly aliases = new AliasRepository();
 *     protected readonly logging = new LoggingConfig();
 *
 * Consequence mesuree sur un R1 ou l'on pose un alias et un reglage de
 * journal depuis la console, puis ou l'on se connecte en SSH :
 *
 *   console  si                     -> Interface  IP-Address ...
 *   ssh      "si"                   -> % Invalid input detected ...
 *   ssh      "show aliases"         -> l'alias `si` MANQUE
 *   console  show logging           -> Buffer logging:   level warnings / 8192 bytes
 *   ssh      "show logging"         -> Buffer logging: level debugging (defaut)
 *
 * Deux vues de la MEME machine, au MEME instant, qui se contredisent sur
 * ce que l'operateur vient de taper : c'est le defaut que la regle 3 de
 * `CLAUDE.md` nomme, et il est ici structurel plutot qu'accidentel —
 * rien ne peut se configurer depuis une porte et se lire depuis l'autre.
 *
 * L'AUTORITE EST CISCO : sur IOS, `alias exec` est une directive de
 * CONFIGURATION GLOBALE (elle se rend dans `running-config`), donc elle
 * vaut pour toute session exec, console ou vty ; et `show logging`
 * projette LE tampon de la machine, pas un tampon par ligne — c'est tout
 * le sens de `logging buffered <taille> <severite>`, qui est elle aussi
 * une directive globale.
 *
 * La correction ne synchronise rien : la coquille de session ADOPTE les
 * magasins de la coquille de la machine, donc il n'y a toujours qu'un
 * seul objet. `Router.getLoggingConfig()` lisait deja celui de la
 * coquille principale — c'est la session qui s'en ecartait.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire la coquille.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 3 des 8 cas tombent. Les 5 autres sont nommes ici, et aucun ne prouve
 * le mecanisme :
 *
 *  - TEMOIN DE LA PORTE SSH : `show ip interface brief` traverse deja la
 *    session et rend sa table. Sans lui, « SSH ne sait pas faire de
 *    show » et « SSH ne voit pas l'alias » seraient indiscernables.
 *  - TEMOINS DE LA CONSOLE : `si` et le reglage du tampon repondent des
 *    DEUX cotes quand on les tape la ou on les a poses. Ce sont eux qui
 *    designent la cause comme etant le magasin de la SESSION, et non
 *    l'alias ou la commande `logging`.
 *  - LA MOITIE CONTRADICTOIRE, qui passait DEJA et qu'il faut dire :
 *    `show running-config | include alias` rend la ligne `alias exec`
 *    par la porte SSH, parce que la configuration courante est
 *    assemblee depuis la coquille de la MACHINE. La meme session
 *    affirmait donc que l'alias est configure et que `show aliases` ne
 *    le connait pas.
 *  - NON-REGRESSION : `show logging` garde son en-tete `Syslog logging:`
 *    des deux cotes — la coquille de session ne doit pas cesser de
 *    rendre la vue en adoptant le magasin d'une autre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ROUTEUR_IP = '10.0.0.6';
const POSTE_IP = '10.0.0.1';
const SECRET = 'Admin@123';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(): Promise<{ r1: CiscoRouter; poste: LinuxPC }> {
  const r1 = new CiscoRouter('R1');
  const poste = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 4, 0, 0);
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(poste.getPort('eth0')!, sw.getPorts()[1]);

  for (const c of [
    'enable',
    'configure terminal',
    'hostname R1',
    'username admin privilege 15 secret ' + SECRET,
    'enable secret ' + SECRET,
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'ip ssh version 2',
    'interface GigabitEthernet0/0',
    `ip address ${ROUTEUR_IP} 255.255.255.0`,
    'no shutdown',
    'exit',
    'line vty 0 4',
    'login local',
    'transport input ssh',
    'exit',
    'alias exec si show ip interface brief',
    'logging buffered 8192 warnings',
    'end',
  ]) await r1.executeCommand(c);

  await poste.executeCommand(`ifconfig eth0 ${POSTE_IP} netmask 255.255.255.0`);
  return { r1, poste };
}

const parSsh = (poste: LinuxPC, commande: string): Promise<string> =>
  poste.executeCommand(`ssh admin@${ROUTEUR_IP} "${commande}"`, `${SECRET}\n`);

describe('la porte SSH fonctionne — le TEMOIN', () => {
  it('une commande `show` traverse la session et rend sa table', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show ip interface brief')).toMatch(/Interface\s+IP-Address/i);
  });
});

describe('la console repond a ce qu\'on y a pose — le TEMOIN', () => {
  it('l\'alias exec s\'y developpe', async () => {
    const { r1 } = await laboratoire();

    expect(await r1.executeCommand('si')).toMatch(/Interface\s+IP-Address/i);
  });

  it('et le reglage du tampon y est rendu', async () => {
    const { r1 } = await laboratoire();

    expect(await r1.executeCommand('show logging')).toMatch(/Buffer logging:\s+level warnings/i);
  });
});

describe('la session SSH lit les MEMES magasins', () => {
  it('l\'alias exec s\'y developpe aussi', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'si')).toMatch(/Interface\s+IP-Address/i);
  });

  it('`show aliases` l\'annonce', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show aliases')).toMatch(/\bsi\b/);
  });

  it('la configuration courante porte la ligne `alias exec`', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show running-config | include alias'))
      .toMatch(/alias exec si show ip interface brief/i);
  });

  it('et `show logging` rend le reglage de la machine', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste, 'show logging')).toMatch(/Buffer logging:\s+level warnings/i);
  });
});

describe('ce que le correctif ne doit pas casser', () => {
  it('`show logging` garde son en-tete des deux cotes', async () => {
    const { r1, poste } = await laboratoire();

    expect(await r1.executeCommand('show logging')).toMatch(/Syslog logging:/i);
    expect(await parSsh(poste, 'show logging')).toMatch(/Syslog logging:/i);
  });
});
