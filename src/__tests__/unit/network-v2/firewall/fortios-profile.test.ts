/**
 * FortiOS — la DEUXIEME declinaison, et la vraie epreuve du contrat.
 *
 * L'ASA a prouve qu'un profil pouvait decrire un constructeur. FortiOS
 * prouve autre chose, et c'est ce qui compte ici : il diverge de l'ASA sur
 * presque tout ce que le BRD avait isole comme axe de variation, donc si le
 * contrat tient pour lui, il tient.
 *
 * Les quatre divergences qui ne sont pas cosmetiques :
 *
 *   1. **Le NAT est un CHAMP de la politique**, pas une politique a part
 *      (`set nat enable`). C'est le drapeau `natIsPolicyField` du profil —
 *      ecrit en phase 3, lu par personne jusqu'ici, exactement le defaut
 *      « stocke et inerte » que ce depot referme partout. `natEnabled`
 *      existait sur `SecurityRule` dans le meme etat.
 *   2. **La politique est une SEQUENCE PURE** terminee par un refus
 *      implicite. Pas de niveaux de securite : aucune regle, aucun trafic,
 *      meme d'une interface « interne » vers l'exterieur. C'est l'inverse
 *      exact de l'ASA, et c'est la premiere chose qui surprend en passant
 *      de l'un a l'autre.
 *   3. **La CLI est hierarchique** — `config` / `edit` / `set` / `next` /
 *      `end` — et non un arbre de commandes a mots-cles.
 *   4. **`edit 0` attribue le prochain identifiant libre**, ce qui est la
 *      facon normale d'ajouter une regle sans en choisir le numero.
 *
 * Aucun moteur n'est ecrit ici : le garde-fou G1 le verifie mecaniquement
 * sur tout le repertoire `vendors/`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { FORTIOS_PROFILE } from '@/network/devices/firewall/vendors/fortios/FortiProfile';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(shell: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = shell.execute(line);
  return last;
}

async function buildLab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  const shell = new FortiShell(fw);
  const inside = new LinuxPC('linux-pc', 'INSIDE', -100, 0);
  const outside = new LinuxPC('linux-pc', 'OUTSIDE', 100, 0);

  new Cable('a').connect(inside.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, outside.getPort('eth0')!);

  fw.configureInterface('port1', { ip: '192.168.1.1', mask: '255.255.255.0' });
  fw.configureInterface('port2', { ip: '203.0.113.1', mask: '255.255.255.0' });

  await runOn(inside, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(outside, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, shell, inside, outside };
}

function permitAll(shell: FortiShell, nat = false) {
  run(shell, 'config firewall policy', 'edit 1',
    'set srcintf port1', 'set dstintf port2',
    'set srcaddr all', 'set dstaddr all',
    'set action accept', 'set schedule always', 'set service ALL',
    ...(nat ? ['set nat enable'] : []),
    'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('FORTIOS_PROFILE — ce qu\'il DECLARE', () => {
  it('le NAT est un CHAMP de la politique', () => {
    expect(FORTIOS_PROFILE.natIsPolicyField).toBe(true);
  });

  it('la politique est liee aux INTERFACES', () => {
    expect(FORTIOS_PROFILE.policyKeyedBy).toBe('interface');
  });

  it('rien ne passe sans regle : refus implicite, pas de niveaux', () => {
    expect(FORTIOS_PROFILE.implicitPolicy).toBe('deny-all');
  });

  it('la configuration est IMMEDIATE', () => {
    expect(FORTIOS_PROFILE.configurationModel).toBe('immediate');
  });

  it('ses ports se nomment `portN`', () => {
    expect(FORTIOS_PROFILE.portPrefix).toBe('port');
    expect(FORTIOS_PROFILE.portFirstIndex).toBe(1);
  });

  it('son contexte virtuel s\'appelle VDOM', () => {
    expect(FORTIOS_PROFILE.virtualizationName).toBe('vdom');
  });

  it('il diverge de l\'ASA sur le NAT — la comparaison est le sujet', async () => {
    const { fw } = await buildLab();

    expect(fw.getProfile().natIsPolicyField).toBe(true);
    expect(fw.getProfile().implicitPolicy).toBe('deny-all');
  });
});

describe('la CLI hierarchique', () => {
  it('l\'invite est celle d\'un FortiGate', async () => {
    const { shell } = await buildLab();

    expect(shell.getPrompt()).toBe('FGT1 # ');
  });

  it('`config` descend, et l\'invite le montre', async () => {
    const { shell } = await buildLab();

    run(shell, 'config firewall policy');

    expect(shell.getPrompt()).toBe('FGT1 (policy) # ');
  });

  it('`edit` descend encore, sur l\'objet nomme', async () => {
    const { shell } = await buildLab();

    run(shell, 'config firewall policy', 'edit 1');

    expect(shell.getPrompt()).toBe('FGT1 (1) # ');
  });

  it('`next` remonte a la table, `end` a la racine', async () => {
    const { shell } = await buildLab();
    run(shell, 'config firewall policy', 'edit 1',
      'set srcintf port2', 'set dstintf port1',
      'set srcaddr all', 'set dstaddr all', 'set service ALL');

    run(shell, 'next');
    expect(shell.getPrompt()).toBe('FGT1 (policy) # ');

    run(shell, 'end');
    expect(shell.getPrompt()).toBe('FGT1 # ');
  });

  it('`edit 0` attribue le prochain identifiant libre', async () => {
    const { fw, shell } = await buildLab();
    permitAll(shell);

    run(shell, 'config firewall policy', 'edit 0',
      'set srcintf port2', 'set dstintf port1',
      'set srcaddr all', 'set dstaddr all', 'set service ALL',
      'set action accept', 'next', 'end');

    expect(fw.getPolicyStore().ordered().map(r => r.id)).toEqual(['1', '2']);
  });

  it('une table inconnue est refusee', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'config firewall zorglub')).toContain('Command fail');
  });

  it('un attribut inconnu est refuse', async () => {
    const { shell } = await buildLab();
    run(shell, 'config firewall policy', 'edit 1');

    expect(run(shell, 'set zorglub 1')).toContain('Command fail');
  });

  it('`set` hors d\'un objet est refuse', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'set srcintf port1')).toContain('Command fail');
  });
});

describe('la politique decide, sur le fil', () => {
  it('SANS regle, rien ne passe — meme de l\'interieur', async () => {
    const { inside } = await buildLab();

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('une regle `accept` ouvre le passage', async () => {
    const { shell, inside } = await buildLab();
    permitAll(shell);

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('une regle `deny` le referme', async () => {
    const { shell, inside } = await buildLab();
    permitAll(shell);
    run(shell, 'config firewall policy', 'edit 1', 'set action deny', 'next', 'end');

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('la regle ne vaut que pour le COUPLE d\'interfaces declare', async () => {
    const { shell, outside } = await buildLab();
    permitAll(shell);

    const out = await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('la regle porte le couple d\'interfaces qu\'on a ecrit', async () => {
    const { fw, shell } = await buildLab();
    permitAll(shell);

    const rule = fw.getPolicyStore().ordered()[0];
    expect(rule.from).toEqual(['port1']);
    expect(rule.to).toEqual(['port2']);
  });
});

describe('`set nat enable` traduit VRAIMENT', () => {
  it('sans lui, la source n\'est pas traduite — le temoin', async () => {
    const { fw, shell } = await buildLab();
    permitAll(shell);

    const result = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', sourcePort: 44001,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('192.168.1.10');
  });

  it('avec lui, la source devient l\'adresse de l\'interface de SORTIE', async () => {
    const { fw, shell } = await buildLab();
    permitAll(shell, true);

    const result = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', sourcePort: 44001,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('203.0.113.1');
  });

  it('le drapeau est bien porte par la REGLE, pas par une politique NAT', async () => {
    const { fw, shell } = await buildLab();
    permitAll(shell, true);

    expect(fw.getPolicyStore().ordered()[0].natEnabled).toBe(true);
    expect(fw.getNatPolicy().size()).toBe(0);
  });

  it('`unset nat` le retire', async () => {
    const { fw, shell } = await buildLab();
    permitAll(shell, true);

    run(shell, 'config firewall policy', 'edit 1', 'unset nat', 'next', 'end');

    expect(fw.getPolicyStore().ordered()[0].natEnabled).toBeFalsy();
  });
});

describe('les vues', () => {
  it('`show firewall policy` reproduit ce qui a ete tape', async () => {
    const { shell } = await buildLab();
    permitAll(shell, true);

    const out = run(shell, 'show firewall policy');

    expect(out).toContain('config firewall policy');
    expect(out).toContain('edit 1');
    expect(out).toContain('set srcintf "port1"');
    expect(out).toContain('set nat enable');
  });

  it('`get system status` nomme la version', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'get system status')).toContain('Version:');
  });

  it('`diagnose sys session list` lit la VRAIE table', async () => {
    const { shell, inside } = await buildLab();
    permitAll(shell);
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'diagnose sys session list')).toContain('192.168.1.10');
  });

  it('elle est vide quand rien n\'a circule — le temoin', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'diagnose sys session list')).not.toContain('192.168.1.10');
  });
});

describe('le FortiGate est un equipement deposable', () => {
  it('`firewall-fortinet` construit un FortiGate, plus un LinuxPC', async () => {
    const { createDevice } = await import('@/network/devices/DeviceFactory');
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();

    expect(createDevice('firewall-fortinet', 0, 0)).toBeInstanceOf(FortiGate);
  });

  it('ses ports portent les noms de FortiOS', async () => {
    const { fw } = await buildLab();

    expect(fw.getPortNames()[0]).toBe('port1');
  });

  it('le catalogue et l\'equipement s\'accordent sur l\'OS', async () => {
    const { DEVICE_CATALOG } = await import('@/network/core/deviceCatalog');
    const { fw } = await buildLab();

    expect(DEVICE_CATALOG['firewall-fortinet'].osType).toBe(fw.getOSType());
  });

  it('on peut ouvrir un terminal dessus', async () => {
    const { createSessionForDevice } = await import('@/terminal/sessions/sessionFactory');
    const { fw } = await buildLab();

    expect(createSessionForDevice(fw, 'T1')).not.toBeNull();
  });
});
