/**
 * SD-WAN : la sonde MESURE, et la selection SUIT la mesure.
 *
 * `config system sdwan` n'avait aucun schema. La matiere existait : le
 * pare-feu route, le cable porte `packetLossRate` — ce qui rend le seuil
 * de perte demontrable — et le pipeline a deja un etage de route de
 * politique, qui est exactement ce qu'une regle de service SD-WAN est.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **La sonde envoie de VRAIS echos** depuis l'interface du membre
 *      vers le serveur declare. Un compteur qui monterait tout seul ne
 *      mesurerait rien.
 *   2. **Un lien coupe donne `state(dead)` et 100 % de perte**, et le
 *      membre sort de la selection.
 *   3. **`packetloss-threshold` decide** : en reglant la perte du cable
 *      au-dessus du seuil, le membre cesse de satisfaire le SLA et le
 *      service bascule sur le suivant.
 *   4. **Les seuils de latence et de gigue sont acceptes et jamais
 *      franchis**, la livraison de trame etant synchrone — meme limite
 *      qu'IP SLA a mesuree, et l'aide le dit.
 *   5. **Le format de `diagnose sys sdwan health-check` est celui de
 *      FortiOS**, releve sur la documentation Fortinet : un membre mort
 *      n'affiche NI latence NI gigue.
 *
 * Le laboratoire est a DEUX fournisseurs qui menent au MEME serveur par
 * une dorsale commune, et ce n'est pas un detail : au premier essai, la
 * sonde visait l'adresse du premier fournisseur, donc le second membre
 * echouait pour une raison de topologie et non de produit. Une bascule
 * qui « marche » parce que le second lien ne menait nulle part ne
 * prouverait rien.
 *
 * Discriminee par `git stash push -- src/network/` : 13 des 14 cas
 * tombent avant correctif. Le seul qui passe des deux cotes est
 * « un membre nommant une interface inconnue est refuse », parce que la
 * commande entiere etait refusee.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const SONDE = '100.64.0.10';

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const lan = new LinuxPC('linux-pc', 'LAN', -100, 0);
  const fai1 = new CiscoRouter('FAI1', 100, -60);
  const fai2 = new CiscoRouter('FAI2', 100, 60);
  const dorsale = new GenericSwitch('switch-generic', 'DORSALE', 8, 220, 0);
  const cible = new LinuxPC('linux-pc', 'CIBLE', 320, 0);

  const cableA = new Cable('wan-a');
  const cableB = new Cable('wan-b');
  new Cable('lan').connect(lan.getPort('eth0')!, fw.getPort('port1')!);
  cableA.connect(fw.getPort('port2')!, fai1.getPort('GigabitEthernet0/0')!);
  cableB.connect(fw.getPort('port3')!, fai2.getPort('GigabitEthernet0/0')!);
  new Cable('d1').connect(fai1.getPort('GigabitEthernet0/1')!, dorsale.getPort('eth0')!);
  new Cable('d2').connect(fai2.getPort('GigabitEthernet0/1')!, dorsale.getPort('eth1')!);
  new Cable('d3').connect(cible.getPort('eth0')!, dorsale.getPort('eth2')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port3"', 'set mode static',
    'set ip 198.51.100.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await configurerFai(fai1, '203.0.113.254', '100.64.0.1');
  await configurerFai(fai2, '198.51.100.254', '100.64.0.2');

  await runOn(lan, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(cible, ['ip link set eth0 up', `ip addr add ${SONDE}/24 dev eth0`,
    'ip route add 203.0.113.0/24 via 100.64.0.1',
    'ip route add 198.51.100.0/24 via 100.64.0.2']);

  return { fw, sh, lan, fai1, fai2, cableA, cableB };
}

async function configurerFai(
  routeur: CiscoRouter, wan: string, dorsale: string,
): Promise<void> {
  await runOn(routeur, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address ${wan} 255.255.255.0`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip address ${dorsale} 255.255.255.0`, 'no shutdown',
    'exit', 'end',
  ]);
}

function sdwan(sh: FortiShell, ...extra: string[]): string {
  return run(sh,
    'config system sdwan',
    'set status enable',
    'config members',
    'edit 1', 'set interface "port2"', 'set gateway 203.0.113.254',
    'set priority 1', 'next',
    'edit 2', 'set interface "port3"', 'set gateway 198.51.100.254',
    'set priority 2', 'next', 'end',
    'config health-check',
    'edit "vers_internet"',
    `set server "${SONDE}"`,
    'set protocol ping',
    'set members 1 2',
    'config sla',
    'edit 1', 'set packetloss-threshold 2', 'next', 'end',
    'next', 'end',
    ...extra,
    'end');
}

beforeEach(() => { Logger.reset(); });

describe('config system sdwan', () => {
  it('les membres se declarent et `show` les rend', async () => {
    const { sh } = await laboratoire();

    sdwan(sh);

    const rendu = sh.execute('show system sdwan');
    expect(rendu).toMatch(/set status enable/);
    expect(rendu).toMatch(/set interface "port2"/);
    expect(rendu).toMatch(/set gateway 203\.0\.113\.254/);
  });

  it('une sonde de sante se declare avec son seuil', async () => {
    const { sh } = await laboratoire();

    sdwan(sh);

    const rendu = sh.execute('show system sdwan');
    expect(rendu).toMatch(/edit "vers_internet"/);
    expect(rendu).toMatch(/set packetloss-threshold 2/);
  });

  it('un membre nommant une interface inconnue est refuse', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh,
      'config system sdwan', 'config members', 'edit 9',
      'set interface "port99"');

    expect(sortie).toMatch(/entry not found|Command fail/);
    run(sh, 'abort');
  });
});

describe('la sonde mesure vraiment', () => {
  it('des echos reels partent vers le serveur declare', async () => {
    const { fw, sh } = await laboratoire();
    sdwan(sh);
    const avant = fw.getPacketCapture().count();

    await fw.runSdwanHealthChecks();

    expect(fw.getPacketCapture().count()).toBeGreaterThan(avant);
  });

  it('un membre joignable est `alive` avec 0 % de perte', async () => {
    const { fw, sh } = await laboratoire();
    sdwan(sh);

    await fw.runSdwanHealthChecks();

    const vue = sh.execute('diagnose sys sdwan health-check');
    expect(vue).toMatch(/Health Check\(vers_internet\)/);
    expect(vue).toMatch(/Seq\(1 port2\): state\(alive\), packet-loss\(0\.000%\)/);
  });

  it('un lien coupe donne `dead` et 100 % de perte', async () => {
    const { fw, sh, cableA } = await laboratoire();
    sdwan(sh);
    cableA.disconnect();

    await fw.runSdwanHealthChecks();

    const vue = sh.execute('diagnose sys sdwan health-check');
    expect(vue).toMatch(/Seq\(1 port2\): state\(dead\), packet-loss\(100\.000%\)/);
  });

  it('un membre mort n`affiche ni latence ni gigue', async () => {
    const { fw, sh, cableA } = await laboratoire();
    sdwan(sh);
    cableA.disconnect();

    await fw.runSdwanHealthChecks();

    const ligne = sh.execute('diagnose sys sdwan health-check')
      .split('\n').find(l => l.includes('Seq(1')) ?? '';
    expect(ligne).not.toMatch(/latency/);
    expect(ligne).not.toMatch(/jitter/);
  });

  it('la perte du cable est ce que la sonde rapporte', async () => {
    const { fw, sh, cableA } = await laboratoire();
    sdwan(sh);
    cableA.setPacketLossRate(1);

    await fw.runSdwanHealthChecks();

    expect(sh.execute('diagnose sys sdwan health-check'))
      .toMatch(/Seq\(1 port2\): state\(dead\), packet-loss\(100\.000%\)/);
  });
});

describe('la selection suit la mesure', () => {
  it('sans defaillance, le membre de priorite 1 est choisi', async () => {
    const { fw, sh } = await laboratoire();
    sdwan(sh);
    await fw.runSdwanHealthChecks();

    expect(fw.getSdwan().preferredMember('vers_internet')?.iface).toBe('port2');
  });

  it('un membre mort sort de la selection', async () => {
    const { fw, sh, cableA } = await laboratoire();
    sdwan(sh);
    cableA.disconnect();

    await fw.runSdwanHealthChecks();

    expect(fw.getSdwan().preferredMember('vers_internet')?.iface).toBe('port3');
  });

  it('un membre au-dessus du seuil de perte ne satisfait plus le SLA', async () => {
    const { fw, sh, cableA } = await laboratoire();
    sdwan(sh);
    cableA.setPacketLossRate(1);

    await fw.runSdwanHealthChecks();

    expect(fw.getSdwan().slaMet('vers_internet', 1, 1)).toBe(false);
    expect(fw.getSdwan().slaMet('vers_internet', 2, 1)).toBe(true);
  });

  it('tous les membres morts : la selection ne rend rien', async () => {
    const { fw, sh, cableA, cableB } = await laboratoire();
    sdwan(sh);
    cableA.disconnect();
    cableB.disconnect();

    await fw.runSdwanHealthChecks();

    expect(fw.getSdwan().preferredMember('vers_internet')?.iface).toBeUndefined();
  });
});

describe('les limites sont dites plutot que niees', () => {
  it('`latency-threshold` est accepte et jamais franchi', async () => {
    const { fw, sh } = await laboratoire();
    sdwan(sh);
    run(sh,
      'config system sdwan', 'config health-check', 'edit "vers_internet"',
      'config sla', 'edit 1', 'set latency-threshold 1', 'next', 'end',
      'next', 'end', 'end');

    await fw.runSdwanHealthChecks();

    expect(sh.execute('show system sdwan')).toMatch(/set latency-threshold 1/);
    expect(fw.getSdwan().slaMet('vers_internet', 1, 1)).toBe(true);
  });

  it('l`aide de `latency-threshold` nomme la limite du simulateur', async () => {
    const { sh } = await laboratoire();

    const aide = run(sh,
      'config system sdwan', 'config health-check', 'edit "x"',
      'config sla', 'edit 1', 'set latency-threshold ?');

    expect(aide.toLowerCase()).toMatch(/synchronous|always 0|virtual/);
    run(sh, 'abort');
  });
});
