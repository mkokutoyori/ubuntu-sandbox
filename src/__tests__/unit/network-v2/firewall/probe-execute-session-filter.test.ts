/**
 * `execute set system session filter` est une SECONDE PORTE sur le filtre
 * de sessions, pas un second filtre.
 *
 * La famille n'existait pas — « unknown action "set" » — alors que le
 * magasin qu'elle gouverne est en place depuis longtemps derriere
 * `diagnose sys session filter`, avec exactement les champs que la
 * reference nomme : src, dst, sport, dport, proto, policy, vd. Un vrai
 * FortiGate a bien deux espaces de noms pour un seul filtre, et c'est
 * cela qu'il fallait reproduire : la nouvelle porte DELEGUE au meme
 * reglage, si bien que ce qu'on ecrit par `execute` se lit par
 * `diagnose` et gouverne la meme liste de sessions. Deux magasins
 * auraient donne deux filtres qui se contredisent sur la meme machine.
 *
 * Ce que la reference ajoute et que la porte `diagnose` n'avait pas :
 * l'effacement CHAMP PAR CHAMP (`clear dport`) a cote de `clear all`.
 * Le reglage partage le porte, et la porte `diagnose` garde son
 * comportement d'origine — `clear` y efface tout — parce que rien
 * n'atteste la forme par champ de ce cote-la et qu'inventer une
 * difference de comportement serait pire que l'absence.
 *
 * `execute sync-session` force une synchronisation de sessions depuis les
 * pairs. Elle emprunte le meme echange FGCP que `execute ha synchronize
 * start` — le magasin et le transport existaient — et refuse en nommant
 * ce qui manque quand l'unite est autonome ou quand `session-pickup` est
 * eteint : sans ce reglage la synchronisation ne transporte rien, et
 * rendre un succes muet ferait croire a un transfert qui n'a pas lieu.
 *
 * Discrimine par `git stash push` : 9 des 11 cas tombent. Les 2 autres
 * sont nommes ici plutot que laisses a decouvrir. « la porte `diagnose`
 * continue de fonctionner » est le TEMOIN de non-regression, dont c'est
 * l'objet de passer des deux cotes. Et « `clear all` efface tout » est
 * VACU avant correctif : la commande qui POSE le filtre n'existant pas
 * non plus, le filtre etait deja vide et l'assertion passait sans rien
 * eprouver ; il ne garde que l'apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { makeFlowKey } from '@/network/devices/firewall/session/FlowKey';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function seul() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

interface Membre { fw: FortiGate; sh: FortiShell }

function membre(nom: string, lan: string): Membre {
  const fw = new FortiGate('firewall-fortinet', nom, 0, 0);
  const sh = new FortiShell(fw);
  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', `set ip ${lan} 255.255.255.0`, 'next', 'end');
  return { fw, sh };
}

function grappe(m: Membre, priorite: number, pickup: boolean): void {
  run(m.sh,
    'config system ha',
    'set group-name "cluster-paris"', 'set group-id 10', 'set mode a-p',
    'set password "SecretHA"', 'set hbdev "port7" 50',
    `set priority ${priorite}`,
    ...(pickup ? ['set session-pickup enable'] : []),
    'end');
}

function laboratoireHa(pickup: boolean) {
  const a = membre('FGT-A', '192.168.1.1');
  const b = membre('FGT-B', '192.168.1.2');
  new Cable('hb').connect(a.fw.getPort('port7')!, b.fw.getPort('port7')!);
  grappe(a, 200, pickup);
  grappe(b, 128, pickup);
  for (let tour = 0; tour < 3; tour++) { a.fw.getHa().tick(); b.fw.getHa().tick(); }
  return { a, b };
}

describe('execute set system session filter', () => {
  it('ecrit dans le filtre que `diagnose` relit', () => {
    const { sh } = seul();

    expect(sh.execute('execute set system session filter src 10.0.0.1'))
      .not.toMatch(/unknown action/i);
    expect(sh.execute('diagnose sys session filter')).toContain('src: 10.0.0.1');
  });

  it('`clear <champ>` n\'efface que ce champ', () => {
    const { sh } = seul();
    run(sh, 'execute set system session filter src 10.0.0.1',
      'execute set system session filter dport 443');

    sh.execute('execute set system session filter clear dport');
    const vue = sh.execute('diagnose sys session filter');
    expect(vue).toContain('src: 10.0.0.1');
    expect(vue).toContain('dst-port: any');
  });

  it('`clear all` efface tout', () => {
    const { sh } = seul();
    run(sh, 'execute set system session filter src 10.0.0.1');

    sh.execute('execute set system session filter clear all');
    expect(sh.execute('diagnose sys session filter')).toContain('src: any');
  });

  it('sans argument, le filtre est rendu', () => {
    const { sh } = seul();
    run(sh, 'execute set system session filter dst 10.9.9.9');

    expect(sh.execute('execute set system session filter')).toContain('dst: 10.9.9.9');
  });

  it('un champ inconnu est refuse dans les deux formes', () => {
    const { sh } = seul();

    expect(sh.execute('execute set system session filter zorglub 1'))
      .toContain('known filters:');
    expect(sh.execute('execute set system session filter clear zorglub'))
      .toContain('known filters:');
  });

  it('le filtre ecrit par `execute` gouverne la liste des sessions', () => {
    const { fw, sh } = seul();
    fw.getSessionTable().install(makeFlowKey('10.0.0.1', 1024, '10.0.0.9', 80, 6), {
      ingressZone: '', egressZone: '', ingressInterface: 'port1',
      egressInterface: 'port2', timeoutSec: 300,
      replyKey: makeFlowKey('10.0.0.9', 80, '10.0.0.1', 1024, 6),
    });
    fw.getSessionTable().install(makeFlowKey('10.0.0.2', 1025, '10.0.0.9', 80, 6), {
      ingressZone: '', egressZone: '', ingressInterface: 'port1',
      egressInterface: 'port2', timeoutSec: 300,
      replyKey: makeFlowKey('10.0.0.9', 80, '10.0.0.2', 1025, 6),
    });

    sh.execute('execute set system session filter src 10.0.0.1');
    const liste = sh.execute('diagnose sys session list');
    expect(liste).toContain('10.0.0.1');
    expect(liste).not.toContain('10.0.0.2');
  });

  it('TEMOIN : la porte `diagnose` continue de fonctionner', () => {
    const { sh } = seul();

    sh.execute('diagnose sys session filter dst 10.4.4.4');
    expect(sh.execute('diagnose sys session filter')).toContain('dst: 10.4.4.4');
    sh.execute('diagnose sys session filter clear');
    expect(sh.execute('diagnose sys session filter')).toContain('dst: any');
  });

  it('une autre commande `set` est refusee', () => {
    const { sh } = seul();

    expect(sh.execute('execute set zorglub')).toContain('unknown action "set zorglub"');
  });
});

describe('execute sync-session', () => {
  it('une unite autonome refuse', () => {
    const { sh } = seul();

    expect(sh.execute('execute sync-session'))
      .toContain('this unit is not part of a cluster.');
  });

  it('sans `session-pickup`, la commande nomme le reglage manquant', () => {
    const { b } = laboratoireHa(false);

    expect(b.sh.execute('execute sync-session'))
      .toContain('session synchronisation needs `set session-pickup enable`.');
  });

  it('avec `session-pickup`, la session du primaire rejoint le secondaire', () => {
    const { a, b } = laboratoireHa(true);
    a.fw.getSessionTable().install(makeFlowKey('10.0.0.1', 1024, '10.0.0.9', 80, 6), {
      ingressZone: '', egressZone: '', ingressInterface: 'port1',
      egressInterface: 'port2', timeoutSec: 300,
      replyKey: makeFlowKey('10.0.0.9', 80, '10.0.0.1', 1024, 6),
    });

    expect(b.sh.execute('execute sync-session')).not.toMatch(/Command fail/i);
    expect(b.fw.getSessionTable().view().statistics().active).toBeGreaterThan(0);
  });
});
