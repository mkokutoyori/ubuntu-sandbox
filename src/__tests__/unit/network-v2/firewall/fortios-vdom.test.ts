/**
 * Phase 5 : les VDOM et les modes de deploiement — laboratoire L7.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait.
 *
 * Quatre points decident de la suite :
 *
 *   1. **Un FortiGate multi-VDOM est UNE machine.** Un chassis, des
 *      ports physiques, une pile, une horloge. Instancier deux
 *      `Firewall` creerait deux caches ARP qu'il faudrait ensuite
 *      recoller : c'est l'inverse du travail a faire (BRD §10.2). Ce
 *      que la sonde mesure, c'est que deux VDOM ne partagent NI objets,
 *      NI politique, NI routes, NI sessions — sur des noms IDENTIQUES,
 *      sans quoi le test passerait pour de mauvaises raisons.
 *   2. **Le mono-VDOM est le cas particulier du cas general.** Aucune
 *      branche conditionnelle dans le pipeline (FGT-VDM-2) : les 944
 *      cas anterieurs restent verts sans qu'un seul ait ete touche.
 *   3. **Une interface appartient a UN VDOM.** L'affecter la retire du
 *      precedent — c'est le mecanisme d'etancheite lui-meme.
 *   4. **Le mode transparent est un autre PIPELINE, pas un drapeau.**
 *      Le profil declare une liste d'etapes par mode (FGT-DEP-6) : le
 *      routage et le NAT n'y figurent pas, `mac-lookup` y figure. Un
 *      drapeau dans une etape aurait laisse les etapes de NAT
 *      s'executer pour ne rien faire.
 *
 * Discriminee par `git stash push -- src/network/` : 19 des 27 cas
 * tombent. La mesure porte sur la MOITIE CLI, le socle ayant ete pousse
 * dans un commit anterieur — c'est dit ici plutot que de laisser croire
 * a une discrimination sur la phase entiere. Les 8 cas qui passent des
 * deux cotes sont ceux que le socle seul decide (le registre existe et
 * contient `root`, une interface non affectee lui appartient, `root` ne
 * se supprime pas, le profil declare un pipeline par mode, le pipeline
 * transparent n'a pas de NAT) et les deux temoins de non-regression.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

function multiVdom(sh: FortiShell): void {
  run(sh, 'config system global', 'set vdom-mode multi-vdom', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('le registre de VDOM', () => {
  it('contient toujours `root`, meme en mono-VDOM', () => {
    const { fw } = shell();

    expect(fw.getVdomRegistry().names()).toContain('root');
    expect(fw.activeVdomName()).toBe('root');
  });

  it('une interface non affectee appartient a `root`', () => {
    const { fw } = shell();

    expect(fw.vdomOfInterface('port1')).toBe('root');
  });

  it('`config vdom` cree un domaine virtuel', () => {
    const { fw, sh } = shell();
    multiVdom(sh);

    run(sh, 'config vdom', 'edit "VENTES"', 'next', 'end');

    expect(fw.getVdomRegistry().names()).toContain('VENTES');
  });

  it('`set vdom-mode multi-vdom` fait apparaitre `config global`', () => {
    const { sh } = shell();

    const avant = run(sh, 'config global');
    multiVdom(sh);
    const apres = run(sh, 'config global');

    expect(avant).toContain('Command fail');
    expect(apres).toBe('');
  });

  it('l\'invite indique le VDOM courant', () => {
    const { sh } = shell();
    multiVdom(sh);

    run(sh, 'config vdom', 'edit "VENTES"');
    const dansVdom = sh.getPrompt();
    run(sh, 'next', 'end');
    run(sh, 'config global');
    const dansGlobal = sh.getPrompt();

    expect(dansVdom).toBe('FGT1 (VENTES) # ');
    expect(dansGlobal).toBe('FGT1 (global) # ');
  });

  it('supprimer un VDOM portant des interfaces est refuse, en les nommant', () => {
    const { fw, sh } = shell();
    multiVdom(sh);
    run(sh, 'config vdom', 'edit "VENTES"', 'next', 'end');
    run(sh, 'config system interface', 'edit "port3"', 'set vdom "VENTES"', 'next', 'end');

    expect(() => fw.getVdomRegistry().remove('VENTES')).toThrowError(/port3/);
  });

  it('`root` ne se supprime pas', () => {
    const { fw } = shell();

    expect(fw.getVdomRegistry().remove('root')).toBe(false);
  });
});

describe('L7 : deux VDOM etanches', () => {
  function deuxVdom(sh: FortiShell): void {
    multiVdom(sh);
    run(sh,
      'config vdom', 'edit "VENTES"', 'next', 'edit "TECHNIQUE"', 'next', 'end',
      'config system interface',
      'edit "port1"', 'set vdom "VENTES"', 'set mode static',
      'set ip 192.168.1.1 255.255.255.0', 'next',
      'edit "port2"', 'set vdom "TECHNIQUE"', 'set mode static',
      'set ip 192.168.1.1 255.255.255.0', 'next', 'end');
  }

  it('une interface affectee quitte le VDOM precedent', () => {
    const { fw, sh } = shell();
    deuxVdom(sh);

    expect(fw.vdomOfInterface('port1')).toBe('VENTES');
    expect(fw.getVdomRegistry().interfacesOf('root')).not.toContain('port1');
  });

  it('deux VDOM ne partagent pas leurs OBJETS, sur le meme nom', () => {
    const { fw, sh } = shell();
    deuxVdom(sh);

    run(sh, 'config vdom', 'edit "VENTES"',
      'config firewall address', 'edit "RESEAU"',
      'set subnet 10.1.0.0 255.255.0.0', 'next', 'end', 'next', 'end');
    run(sh, 'config vdom', 'edit "TECHNIQUE"',
      'config firewall address', 'edit "RESEAU"',
      'set subnet 10.2.0.0 255.255.0.0', 'next', 'end', 'next', 'end');

    expect(fw.getObjectStore('VENTES').getAddress('RESEAU')?.value).toBe('10.1.0.0');
    expect(fw.getObjectStore('TECHNIQUE').getAddress('RESEAU')?.value).toBe('10.2.0.0');
  });

  it('deux VDOM ne partagent pas leur POLITIQUE, sur le meme identifiant', () => {
    const { fw, sh } = shell();
    deuxVdom(sh);

    run(sh, 'config vdom', 'edit "VENTES"',
      'config firewall policy', 'edit 1', 'set name "VENTE"', 'set action accept',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'next', 'end', 'next', 'end');

    expect(fw.getPolicyStore('VENTES').byId('1')?.name).toBe('VENTE');
    expect(fw.getPolicyStore('TECHNIQUE').byId('1')).toBeUndefined();
  });

  it('deux VDOM ne partagent pas leurs ROUTES', () => {
    const { fw, sh } = shell();
    deuxVdom(sh);

    run(sh, 'config vdom', 'edit "VENTES"',
      'config router static', 'edit 1',
      'set dst 0.0.0.0 0.0.0.0', 'set gateway 192.168.1.254', 'set device "port1"',
      'next', 'end', 'next', 'end');

    expect(fw.getRouteTable('VENTES').all().some(r => r.kind === 'default')).toBe(true);
    expect(fw.getRouteTable('TECHNIQUE').all().some(r => r.kind === 'default')).toBe(false);
  });

  it('deux VDOM ne partagent pas leurs SESSIONS', async () => {
    const { fw, sh } = shell();
    const poste = new LinuxPC('linux-pc', 'POSTE', -100, 0);
    new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
    deuxVdom(sh);

    run(sh, 'config vdom', 'edit "VENTES"',
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end', 'next', 'end');

    await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
      'ip route add default via 192.168.1.1']);
    await pingOnSimulatedClock(poste, 'ping -c 1 192.168.1.50');

    expect(fw.getSessionTable('TECHNIQUE').count()).toBe(0);
  });

  it('la table de routage d\'un VDOM ne voit que SES interfaces', () => {
    const { fw, sh } = shell();
    deuxVdom(sh);

    const ventes = fw.getRouteTable('VENTES').all().map(route => route.iface);
    const technique = fw.getRouteTable('TECHNIQUE').all().map(route => route.iface);

    expect(ventes).toContain('port1');
    expect(ventes).not.toContain('port2');
    expect(technique).toContain('port2');
    expect(technique).not.toContain('port1');
  });
});

describe('config system vdom-link', () => {
  it('cree deux interfaces reliees dos a dos', () => {
    const { fw, sh } = shell();
    multiVdom(sh);

    run(sh, 'config global', 'config system vdom-link', 'edit "lien1"', 'next', 'end', 'end');

    expect(fw.getPort('lien10')).toBeDefined();
    expect(fw.getPort('lien11')).toBeDefined();
    expect(fw.vdomLinkPeer('lien10')).toBe('lien11');
  });

  it('les deux bouts sont vraiment cables l\'un a l\'autre', () => {
    const { fw, sh } = shell();
    multiVdom(sh);

    run(sh, 'config global', 'config system vdom-link', 'edit "lien1"', 'next', 'end', 'end');

    expect(fw.getPort('lien10')?.isConnected()).toBe(true);
    expect(fw.getPort('lien11')?.isConnected()).toBe(true);
  });

  it('chaque bout peut appartenir a un VDOM different', () => {
    const { fw, sh } = shell();
    multiVdom(sh);
    run(sh, 'config vdom', 'edit "VENTES"', 'next', 'end');
    run(sh, 'config global', 'config system vdom-link', 'edit "lien1"', 'next', 'end', 'end');

    run(sh, 'config system interface',
      'edit "lien10"', 'set vdom "root"', 'set mode static',
      'set ip 10.255.255.1 255.255.255.252', 'next',
      'edit "lien11"', 'set vdom "VENTES"', 'set mode static',
      'set ip 10.255.255.2 255.255.255.252', 'next', 'end');

    expect(fw.vdomOfInterface('lien10')).toBe('root');
    expect(fw.vdomOfInterface('lien11')).toBe('VENTES');
  });
});

describe('config system switch-interface', () => {
  it('regroupe des ports physiques', () => {
    const { fw, sh } = shell();

    run(sh, 'config system switch-interface', 'edit "lan"',
      'set member "port3" "port4" "port5"', 'next', 'end');

    expect(fw.switchInterfaces()).toContain('lan');
    expect(fw.switchMembers('lan')).toEqual(['port3', 'port4', 'port5']);
    expect(fw.sameSwitchInterface('port3', 'port4')).toBe(true);
    expect(fw.sameSwitchInterface('port3', 'port1')).toBe(false);
  });

  it('le trafic entre membres ne traverse pas la politique', () => {
    const { fw, sh } = shell();

    run(sh,
      'config system interface',
      'edit "port3"', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
      'config system switch-interface', 'edit "lan"',
      'set member "port3" "port4"', 'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port3', protocol: 'tcp',
      sourceIP: '10.0.0.10', destinationIP: '10.0.0.20',
      sourcePort: 40000, destinationPort: 80,
    });

    expect(vu.allowed).toBe(true);
    expect(vu.trace.map(entry => entry.stage)).not.toContain('policy-lookup');
    expect(vu.egressPort).toBe('port4');
  });

  it('le temoin : hors du groupe, la politique decide et refuse', () => {
    const { fw, sh } = shell();

    run(sh,
      'config system interface',
      'edit "port3"', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next',
      'edit "port1"', 'set mode static', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end',
      'config system switch-interface', 'edit "lan"',
      'set member "port3" "port4"', 'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '10.9.0.10', destinationIP: '10.0.0.20',
      sourcePort: 40000, destinationPort: 80,
    });

    expect(vu.allowed).toBe(false);
    expect(vu.trace.map(entry => entry.stage)).toContain('policy-lookup');
  });
});

describe('le mode transparent', () => {
  it('le profil declare un pipeline PAR MODE', () => {
    const { fw } = shell();
    const pipeline = fw.getProfile().pipeline;

    expect(pipeline.nat).toContain('route-lookup');
    expect(pipeline.nat).toContain('nat-source');
    expect(pipeline.transparent).not.toContain('route-lookup');
    expect(pipeline.transparent).not.toContain('nat-source');
    expect(pipeline.transparent).toContain('mac-lookup');
  });

  it('`set opmode transparent` change le mode du VDOM', () => {
    const { fw, sh } = shell();

    run(sh, 'config system settings', 'set opmode transparent', 'end');

    expect(fw.operationMode()).toBe('transparent');
  });

  it('en mode transparent, une interface ne prend pas d\'adresse', () => {
    const { sh } = shell();
    run(sh, 'config system settings', 'set opmode transparent', 'end');

    run(sh, 'config system interface', 'edit "port1"');
    const refus = run(sh, 'set ip 192.168.1.1 255.255.255.0');

    expect(refus).not.toBe('');
    expect(refus).toContain('does not apply');
  });

  it('`manageip` n\'existe QUE en mode transparent', () => {
    const { sh } = shell();

    run(sh, 'config system settings');
    const enNat = run(sh, 'set manageip 192.168.1.99 255.255.255.0');
    run(sh, 'set opmode transparent');
    const enTransparent = run(sh, 'set manageip 192.168.1.99 255.255.255.0');

    expect(enNat).not.toBe('');
    expect(enTransparent).toBe('');
  });

  it('`manageip` est retenue par la machine', () => {
    const { fw, sh } = shell();

    run(sh, 'config system settings', 'set opmode transparent',
      'set manageip 192.168.1.99 255.255.255.0',
      'set gateway 192.168.1.1', 'end');

    expect(fw.managementAddress()).toBe('192.168.1.99');
  });

  it('en mode transparent, le NAT de politique n\'est plus une question', () => {
    const { fw, sh } = shell();
    run(sh, 'config system settings', 'set opmode transparent', 'end');

    const etapes = fw.getPipeline('transparent').stageNames();

    expect(etapes).not.toContain('nat-destination');
    expect(etapes).not.toContain('nat-source');
    expect(etapes).toContain('policy-lookup');
  });

  it('la politique s\'applique quand meme, sans routage', () => {
    const { fw, sh } = shell();
    run(sh, 'config system settings', 'set opmode transparent', 'end');
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '192.168.1.20',
      sourcePort: 40000, destinationPort: 80,
    });

    expect(vu.trace.map(entry => entry.stage)).not.toContain('route-lookup');
    expect(vu.trace.map(entry => entry.stage)).toContain('policy-lookup');
  });

  it('le temoin : en mode NAT la meme topologie passe par le routage', () => {
    const { fw } = shell();

    const etapes = fw.getPipeline('nat').stageNames();

    expect(etapes).toContain('route-lookup');
  });
});
