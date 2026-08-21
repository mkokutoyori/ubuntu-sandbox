/**
 * FGCP : deux FortiGate elisent un primaire, et le fil en decide.
 *
 * `config system ha` n'avait aucun schema. La contrainte P6 du socle est
 * la seule chose qui rende ce chapitre instructif : **la synchronisation
 * traverse le fil**. Debrancher `hbdev` doit produire un cerveau divise
 * observable — les deux membres se croient primaires — et une
 * synchronisation en memoire rendrait ce laboratoire impossible.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **L'ordre de departage est celui de FortiOS**, et chacun de ses
 *      quatre criteres a son cas : d'abord le nombre d'interfaces
 *      surveillees ACTIVES, puis la priorite, puis la duree de
 *      fonctionnement, puis le numero de serie. Debrancher un cable
 *      surveille fait basculer le role sans qu'on ait touche a une
 *      priorite — c'est ce que le chapitre existe pour montrer.
 *   2. **Les battements de coeur sont de vraies trames** sur `hbdev`.
 *   3. **`get system ha status` dit POURQUOI** le primaire a ete elu :
 *      la ligne `Master selected using:` est la valeur pedagogique de
 *      cette vue, et son texte est releve sur une sortie reelle.
 *   4. **`override` decide du retour** : sans lui, le membre revenu reste
 *      secondaire ; avec, il reprend la main.
 *   5. **`session-pickup` fait survivre une session au basculement**, et
 *      son absence la casse.
 *
 * Le laboratoire donne a CHAQUE membre ses propres liens surveilles, et
 * ce n'est pas un detail : au premier essai les deux membres partageaient
 * les cables, donc en couper un faisait perdre une interface aux DEUX et
 * le critere ne departageait rien.
 *
 * Discriminee par `git stash push -- src/network/` : 27 des 28 cas
 * tombent avant correctif. Le seul qui passe des deux cotes est
 * « `standalone` est le mode par defaut, et n'elit rien », parce
 * qu'aucun mode n'existait.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { makeFlowKey } from '@/network/devices/firewall/session/FlowKey';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Membre {
  fw: FortiGate;
  sh: FortiShell;
}

function membre(nom: string, lan: string): Membre {
  const fw = new FortiGate('firewall-fortinet', nom, 0, 0);
  const sh = new FortiShell(fw);
  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${lan} 255.255.255.0`, 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'next', 'end');
  return { fw, sh };
}

function grappe(m: Membre, priorite: number, ...extra: string[]): string {
  return run(m.sh,
    'config system ha',
    'set group-name "cluster-paris"',
    'set group-id 10',
    'set mode a-p',
    'set password "SecretHA"',
    'set hbdev "port7" 50',
    `set priority ${priorite}`,
    'set monitor "port1" "port2"',
    ...extra,
    'end');
}

interface Labo {
  a: Membre;
  b: Membre;
  coeur: Cable;
  lanA: Cable;
  lanB: Cable;
  temoinA1: LinuxPC;
}

function laboratoire(
  options: { prioriteA?: number; prioriteB?: number; extraA?: string[]; extraB?: string[] } = {},
): Labo {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const a = membre('FGT-A', '192.168.1.1');
  const b = membre('FGT-B', '192.168.1.2');

  const temoinA1 = new LinuxPC('linux-pc', 'T-A1', 0, 0);
  const temoinA2 = new LinuxPC('linux-pc', 'T-A2', 0, 0);
  const temoinB1 = new LinuxPC('linux-pc', 'T-B1', 0, 0);
  const temoinB2 = new LinuxPC('linux-pc', 'T-B2', 0, 0);

  const coeur = new Cable('hb');
  const lanA = new Cable('lan-a');
  const lanB = new Cable('lan-b');
  coeur.connect(a.fw.getPort('port7')!, b.fw.getPort('port7')!);
  lanA.connect(a.fw.getPort('port1')!, temoinA1.getPort('eth0')!);
  new Cable('wan-a').connect(a.fw.getPort('port2')!, temoinA2.getPort('eth0')!);
  lanB.connect(b.fw.getPort('port1')!, temoinB1.getPort('eth0')!);
  new Cable('wan-b').connect(b.fw.getPort('port2')!, temoinB2.getPort('eth0')!);

  grappe(a, options.prioriteA ?? 200, ...(options.extraA ?? []));
  grappe(b, options.prioriteB ?? 128, ...(options.extraB ?? []));

  return { a, b, coeur, lanA, lanB, temoinA1 };
}

function battre(labo: Labo, tours = 3): void {
  for (let tour = 0; tour < tours; tour++) {
    labo.a.fw.getHa().tick();
    labo.b.fw.getHa().tick();
  }
}

function role(m: Membre): string {
  return m.fw.getHa().role();
}

beforeEach(() => { Logger.reset(); });

describe('config system ha', () => {
  it('la grappe se declare et `show` la reproduit', () => {
    const { a } = laboratoire();

    const rendu = a.sh.execute('show system ha');
    expect(rendu).toMatch(/set group-name "cluster-paris"/);
    expect(rendu).toMatch(/set mode a-p/);
    expect(rendu).toMatch(/set priority 200/);
  });

  it('le mot de passe n`est pas rendu en clair', () => {
    const { a } = laboratoire();

    expect(a.sh.execute('show system ha')).not.toMatch(/SecretHA/);
  });

  it('`set hbdev` nommant une interface inconnue est refuse', () => {
    const { a } = laboratoire();

    const sortie = run(a.sh, 'config system ha', 'set hbdev "port99" 50', 'end');

    expect(sortie).toMatch(/entry not found|Command fail/);
    run(a.sh, 'abort');
  });

  it('`standalone` est le mode par defaut, et n`elit rien', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const seul = membre('FGT-SEUL', '192.168.1.1');

    expect(seul.fw.getHa().role()).toBe('standalone');
  });
});

describe('les battements de coeur traversent le fil', () => {
  it('de vraies trames partent sur `hbdev`', () => {
    const labo = laboratoire();
    const avant = labo.a.fw.getPacketCapture().count();

    battre(labo, 1);

    expect(labo.a.fw.getPacketCapture().count()).toBeGreaterThan(avant);
  });

  it('le membre distant les recoit et la grappe se forme', () => {
    const labo = laboratoire();

    battre(labo);

    expect(role(labo.a)).toBe('master');
    expect(role(labo.b)).toBe('slave');
  });

  it('un groupe different n`est pas la meme grappe', () => {
    const labo = laboratoire();
    run(labo.b.sh, 'config system ha', 'set group-id 99', 'end');

    battre(labo);

    expect(role(labo.a)).toBe('master');
    expect(role(labo.b)).toBe('master');
  });

  it('un mot de passe different est rejete', () => {
    const labo = laboratoire();
    run(labo.b.sh, 'config system ha', 'set password "AutreSecret"', 'end');

    battre(labo);

    expect(role(labo.b)).toBe('master');
  });
});

describe('l`ordre de departage', () => {
  it('la plus grande priorite l`emporte', () => {
    const labo = laboratoire({ prioriteA: 100, prioriteB: 250 });

    battre(labo);

    expect(role(labo.b)).toBe('master');
  });

  it('une interface surveillee perdue passe AVANT la priorite', () => {
    const labo = laboratoire();
    battre(labo);
    expect(role(labo.a)).toBe('master');

    labo.lanA.disconnect();
    battre(labo);

    expect(role(labo.b)).toBe('master');
    expect(role(labo.a)).toBe('slave');
  });

  it('a egalite de priorite, la plus longue duree de fonctionnement gagne', () => {
    const labo = laboratoire({ prioriteA: 128, prioriteB: 128 });
    labo.a.fw.getHa().advanceUptime(3600_000);

    battre(labo);

    expect(role(labo.a)).toBe('master');
  });

  it('a egalite complete, le plus grand numero de serie gagne', () => {
    const labo = laboratoire({ prioriteA: 128, prioriteB: 128 });

    battre(labo);

    const attendu = labo.a.fw.serialNumber() > labo.b.fw.serialNumber()
      ? labo.a : labo.b;
    expect(role(attendu)).toBe('master');
  });
});

describe('le cerveau divise', () => {
  it('debrancher `hbdev` fait croire aux deux qu`ils sont primaires', () => {
    const labo = laboratoire();
    battre(labo);
    expect(role(labo.b)).toBe('slave');

    labo.coeur.disconnect();
    battre(labo, 8);

    expect(role(labo.a)).toBe('master');
    expect(role(labo.b)).toBe('master');
  });

  it('rebrancher `hbdev` resorbe le cerveau divise', () => {
    const labo = laboratoire();
    battre(labo);
    labo.coeur.disconnect();
    battre(labo, 8);
    expect(role(labo.b)).toBe('master');

    labo.coeur.connect(labo.a.fw.getPort('port7')!, labo.b.fw.getPort('port7')!);
    battre(labo, 4);

    expect(role(labo.b)).toBe('slave');
  });
});

describe('get system ha status', () => {
  it('rend le format de FortiOS et nomme les deux membres', () => {
    const labo = laboratoire();
    battre(labo);

    const vue = labo.a.sh.execute('get system ha status');
    expect(vue).toMatch(/HA Health Status: OK/);
    expect(vue).toMatch(/Mode: HA A-P/);
    expect(vue).toMatch(/Group Name: cluster-paris/);
    expect(vue).toMatch(/Group ID: 10/);
    expect(vue).toMatch(/^Master: FGT-A, /m);
    expect(vue).toMatch(/^Slave : FGT-B, /m);
  });

  it('dit POURQUOI le primaire a ete elu', () => {
    const labo = laboratoire({ prioriteA: 250, prioriteB: 100 });
    battre(labo);

    expect(labo.a.sh.execute('get system ha status'))
      .toMatch(/Master selected using:[\s\S]*priority/);
  });

  it('le membre seul le dit dans le meme champ', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const seul = membre('FGT-SEUL', '192.168.1.1');
    grappe(seul, 128);
    seul.fw.getHa().tick();

    expect(seul.sh.execute('get system ha status'))
      .toMatch(/only member in the cluster/);
  });

  it('`ses_pickup` et `override` sont rendus tels que configures', () => {
    const labo = laboratoire({ extraA: ['set session-pickup enable', 'set override enable'] });
    battre(labo);

    const vue = labo.a.sh.execute('get system ha status');
    expect(vue).toMatch(/ses_pickup: enable/);
    expect(vue).toMatch(/override: enable/);
  });
});

describe('la configuration se synchronise par le fil', () => {
  it('un objet cree sur le primaire parait sur le secondaire', () => {
    const labo = laboratoire();
    battre(labo);

    run(labo.a.sh,
      'config firewall address', 'edit "SERVEUR"',
      'set subnet 10.0.0.5 255.255.255.255', 'next', 'end');
    battre(labo);

    expect(labo.b.fw.getObjectStore().getAddress('SERVEUR')).toBeDefined();
  });

  it('`diagnose sys ha checksum show` concorde quand la grappe est synchrone', () => {
    const labo = laboratoire();
    battre(labo);

    const vueA = labo.a.sh.execute('diagnose sys ha checksum show');
    const vueB = labo.b.sh.execute('diagnose sys ha checksum show');
    expect(vueA).toBe(vueB);
  });

  it('il DIFFERE quand le fil est coupe et qu`un membre change', () => {
    const labo = laboratoire();
    battre(labo);
    labo.coeur.disconnect();

    run(labo.a.sh,
      'config firewall address', 'edit "DESYNC"',
      'set subnet 10.0.0.9 255.255.255.255', 'next', 'end');
    battre(labo);

    expect(labo.a.sh.execute('diagnose sys ha checksum show'))
      .not.toBe(labo.b.sh.execute('diagnose sys ha checksum show'));
  });
});

describe('override et le retour du membre', () => {
  it('sans `override`, le membre revenu reste secondaire', () => {
    const labo = laboratoire();
    battre(labo);
    labo.lanA.disconnect();
    battre(labo);
    expect(role(labo.b)).toBe('master');

    labo.lanA.connect(labo.a.fw.getPort('port1')!, labo.temoinA1.getPort('eth0')!);
    battre(labo);

    expect(role(labo.b)).toBe('master');
    expect(role(labo.a)).toBe('slave');
  });

  it('avec `override`, la plus grande priorite reprend la main', () => {
    const labo = laboratoire({
      extraA: ['set override enable'], extraB: ['set override enable'],
    });
    battre(labo);
    labo.lanA.disconnect();
    battre(labo);
    expect(role(labo.b)).toBe('master');

    labo.lanA.connect(labo.a.fw.getPort('port1')!, labo.temoinA1.getPort('eth0')!);
    battre(labo);

    expect(role(labo.a)).toBe('master');
  });
});

describe('session-pickup', () => {
  function poserSession(m: Membre): void {
    m.fw.getVdom().sessions.install(
      makeFlowKey('192.168.1.10', 44000, '203.0.113.9', 443, 6),
      {
        ingressZone: 'port1', egressZone: 'port2',
        ingressInterface: 'port1', egressInterface: 'port2',
        timeoutSec: 3600,
      });
  }

  it('active, la session du primaire parait chez le secondaire', () => {
    const labo = laboratoire({
      extraA: ['set session-pickup enable'], extraB: ['set session-pickup enable'],
    });
    battre(labo);
    poserSession(labo.a);

    battre(labo);

    expect(labo.b.fw.getVdom().sessions.view().count()).toBe(1);
  });

  it('sans elle, la session ne traverse pas', () => {
    const labo = laboratoire();
    battre(labo);
    poserSession(labo.a);

    battre(labo);

    expect(labo.b.fw.getVdom().sessions.view().count()).toBe(0);
  });

  it('la session reprise porte la politique et les interfaces du primaire', () => {
    const labo = laboratoire({
      extraA: ['set session-pickup enable'], extraB: ['set session-pickup enable'],
    });
    battre(labo);
    poserSession(labo.a);
    battre(labo);

    const reprise = labo.b.fw.getVdom().sessions.view().all()[0];
    expect(reprise.ingressInterface).toBe('port1');
    expect(reprise.egressInterface).toBe('port2');
  });
});

describe('execute ha', () => {
  it('`execute ha failover set` force le basculement', () => {
    const labo = laboratoire();
    battre(labo);

    labo.a.sh.execute('execute ha failover set');
    battre(labo);

    expect(role(labo.b)).toBe('master');
  });

  it('`execute ha manage` refuse un numero de membre inconnu', () => {
    const labo = laboratoire();
    battre(labo);

    expect(labo.a.sh.execute('execute ha manage 9')).toMatch(/Command fail|not found/);
  });
});
