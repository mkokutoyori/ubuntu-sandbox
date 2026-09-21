/**
 * VACL VRP et filtre de port sur les trames inondees — deux manquements
 * au meme joint.
 *
 * V-01 — VRP N'AVAIT PAS `traffic-filter vlan <n> inbound|outbound`.
 *   `TODO.md` [acl] le portait, mesure : la commande rendait
 *   `Error: Unrecognized command found at '^' position.` — refus
 *   honnete, mais un laboratoire VACL etait infaisable sur VRP alors
 *   que Cisco a sa carte d'acces de VLAN. Le joint existait deja :
 *   `handleFrame` porte une << Step 2.7 : VLAN-scoped filtering (Cisco
 *   VACL / Huawei MQC) >> ou les deux autres filtres de VLAN se
 *   decident. La liaison VRP s'y branche, plutot que dans un troisieme
 *   endroit qui finirait par contredire les deux premiers.
 *
 *   Nuance que `TODO.md` nommait, et qui est tenue : la politique VRP
 *   pour un paquet qu'aucune regle n'apparie est `permit`, donc
 *   l'evaluation passe par `evaluateForDataPlane` — la meme que
 *   `traffic-filter` sur un port — et NON par `evaluateACLByName`, qui
 *   porte la convention de Cisco.
 *
 * V-02 — `traffic-filter outbound` NE FILTRAIT PAS CE QUI EST INONDE.
 *   Trouve en lisant le point d'appel de V-01 : `forwardToPort`
 *   consultait `portAclPermits`, `floodFrame` ne le consultait nulle
 *   part. Une ACL de sortie posee sur un port filtrait donc l'unicast
 *   APPRIS et laissait passer la diffusion, l'unicast inconnu et le
 *   multicast par le meme port — la direction permissive, sur un
 *   critere de securite.
 *
 * COMMENT CE BANC MESURE L'INONDATION. En DIFFERENCE, jamais en absolu :
 * une ACL IPv4 ne filtre pas l'ARP, et `ping -b` en met sur le fil avant
 * les deux diffusions IPv4. Attendre << zero trame recue >> serait une
 * fausse attente ; ce qui se mesure est l'ecart entre le meme echange
 * avec et sans le filtre.
 *
 * Discrimination : 4 cas sur 8 tombent sous `git stash push -- src/network`.
 * Les quatre autres, et pourquoi ils passent des deux cotes :
 *
 *   - << l'unicast appris reste filtre >> : c'etait la seule moitie qui
 *     appliquait deja. Non-regression : ajouter le controle a
 *     l'inondation ne doit pas casser celui du renvoi unicast.
 *   - << une source que l'ACL ne vise pas traverse toujours >> : TEMOIN.
 *     Sans lui, le cas qui refuse ne distinguerait pas << le filtre
 *     applique >> de << ce lien ne porte plus rien >>.
 *   - << l'ARP passe toujours >> : TEMOIN de la mesure en difference.
 *     Il tient que le compte non nul de [flood-2] est NORMAL, et non le
 *     signe d'un filtre inerte.
 *   - << un VLAN que le filtre ne vise pas n'est pas touche >> : sur la
 *     base la commande etait REFUSEE, donc rien n'etait pose et le ping
 *     passait — il avait raison pour une autre raison. Il garde
 *     desormais que la liaison est bien portee PAR VLAN, et non posee
 *     globalement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../support/fastPing';

beforeEach(() => {
  resetCounters(); MACAddress.resetCounter(); resetDeviceCounters();
  Logger.reset(); EquipmentRegistry.resetInstance();
});

async function vrp(sw: HuaweiSwitch, lignes: string[]): Promise<string> {
  let out = '';
  for (const c of lignes) out = await sw.executeCommand(c);
  return out;
}

const perteEnPourcent = async (pc: LinuxPC, ip: string): Promise<number> => {
  const sortie = await pingOnSimulatedClock(pc, `ping -c 2 -W 1 ${ip}`);
  const m = sortie.match(/(\d+)% packet loss/);
  return m ? Number(m[1]) : -1;
};

async function labo() {
  const sw = new HuaweiSwitch('switch-huawei', 'SW', 5);
  const a = new LinuxPC('linux-pc', 'PC-A', 0, 0);
  const b = new LinuxPC('linux-pc', 'PC-B', 0, 0);
  new Cable('ca').connect(a.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('cb').connect(b.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);
  await a.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
  await b.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
  return { sw, a, b };
}

async function poserAcl(sw: HuaweiSwitch, regleDeny: string): Promise<void> {
  await vrp(sw, ['system-view',
    'acl number 3000',
    `rule 5 deny ip ${regleDeny}`,
    'rule 10 permit ip source any destination any',
    'quit']);
}

describe('V-01 — `traffic-filter vlan <n> inbound|outbound acl <n>`', () => {
  it('la commande est acceptee et se rend dans la configuration', async () => {
    const { sw } = await labo();
    await poserAcl(sw, 'source 192.168.1.10 0');
    expect((await sw.executeCommand('traffic-filter vlan 1 inbound acl 3000')).trim()).toBe('');
    await sw.executeCommand('return');
    expect(await sw.executeCommand('display current-configuration'))
      .toMatch(/^traffic-filter vlan 1 inbound acl 3000$/m);
  }, 30000);

  it('elle APPLIQUE : la source que l ACL refuse ne traverse plus le VLAN', async () => {
    const { sw, a } = await labo();
    await poserAcl(sw, 'source 192.168.1.10 0');
    await vrp(sw, ['traffic-filter vlan 1 inbound acl 3000', 'return']);
    expect(await perteEnPourcent(a, '192.168.1.20')).toBe(100);
  }, 30000);

  it('TEMOIN — une source que l ACL ne vise pas traverse toujours', async () => {
    const { sw, a } = await labo();
    await poserAcl(sw, 'source 192.168.1.99 0');
    await vrp(sw, ['traffic-filter vlan 1 inbound acl 3000', 'return']);
    expect(await perteEnPourcent(a, '192.168.1.20')).toBe(0);
  }, 30000);

  it('`undo` la retire, de la configuration et du plan de donnees', async () => {
    const { sw, a } = await labo();
    await poserAcl(sw, 'source 192.168.1.10 0');
    await vrp(sw, ['traffic-filter vlan 1 inbound acl 3000']);
    expect((await sw.executeCommand('undo traffic-filter vlan 1 inbound')).trim()).toBe('');
    await sw.executeCommand('return');
    expect(await sw.executeCommand('display current-configuration'))
      .not.toMatch(/traffic-filter vlan/);
    expect(await perteEnPourcent(a, '192.168.1.20')).toBe(0);
  }, 30000);

  it('un VLAN que le filtre ne vise pas n est pas touche', async () => {
    const { sw, a } = await labo();
    await poserAcl(sw, 'source 192.168.1.10 0');
    await vrp(sw, ['traffic-filter vlan 777 inbound acl 3000', 'return']);
    expect(await perteEnPourcent(a, '192.168.1.20')).toBe(0);
  }, 30000);
});

describe('V-02 — le filtre de sortie et les trames inondees', () => {
  async function diffusionRecue(avecFiltre: boolean): Promise<number> {
    const { sw, a, b } = await labo();
    if (avecFiltre) {
      await poserAcl(sw, 'destination 192.168.1.255 0');
      await vrp(sw, ['interface GigabitEthernet 0/0/2',
        'traffic-filter outbound acl 3000', 'quit', 'return']);
    }
    const avant = b.getPort('eth0')!.getCounters().framesIn;
    await a.executeCommand('ping -c 2 -b 192.168.1.255');
    return b.getPort('eth0')!.getCounters().framesIn - avant;
  }

  it('une diffusion IPv4 que l ACL de sortie refuse n atteint plus le port', async () => {
    const sans = await diffusionRecue(false);
    const avec = await diffusionRecue(true);
    expect(sans).toBeGreaterThan(0);
    expect(sans - avec).toBe(2);
  }, 30000);

  it('TEMOIN — l ARP, que l ACL IPv4 ne nomme pas, passe toujours', async () => {
    const { sw, a, b } = await labo();
    await poserAcl(sw, 'destination 192.168.1.255 0');
    await vrp(sw, ['interface GigabitEthernet 0/0/2',
      'traffic-filter outbound acl 3000', 'quit', 'return']);
    const avant = b.getPort('eth0')!.getCounters().framesIn;
    await a.executeCommand('ping -c 2 -b 192.168.1.255');
    expect(b.getPort('eth0')!.getCounters().framesIn - avant).toBeGreaterThan(0);
  }, 30000);

  it('NON-REGRESSION — l unicast appris reste filtre par la meme ACL', async () => {
    const { sw, a } = await labo();
    await poserAcl(sw, 'destination 192.168.1.20 0');
    await vrp(sw, ['interface GigabitEthernet 0/0/2',
      'traffic-filter outbound acl 3000', 'quit', 'return']);
    expect(await perteEnPourcent(a, '192.168.1.20')).toBe(100);
  }, 30000);
});
