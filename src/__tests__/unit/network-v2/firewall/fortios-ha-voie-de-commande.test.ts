/**
 * Le battement de coeur porte une VOIE DE COMMANDE.
 *
 * Deux entrees `[ha]` de `TODO.md` reportent la meme cause : FGCP n'a
 * qu'une annonce periodique a SENS UNIQUE. Il manque un echange
 * requete/reponse, et c'est un seul mecanisme qui ferme les deux.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate, dont la
 * documentation lie les deux commandes en UN mode operatoire :
 * `execute ha manage <index> <compte>`, puis `execute ha synchronize
 * start` sur le subordonne, puis `exit`.
 *
 *   1. `execute ha manage 1 admin` demande un mot de passe.
 *   2. Le mot de passe est evalue contre le magasin de comptes du membre
 *      CIBLE, pas du membre local : c'est une propriete de securite, pas
 *      un detail d'invite.
 *   3. Une fois entre, l'invite est celle du membre DISTANT.
 *   4. Une commande tapee la-bas s'execute LA-BAS : `get system status`
 *      rend le numero de serie du distant.
 *   5. `exit` ramene sur le membre local.
 *   6. Un index qui ne designe aucun membre est refuse.
 *   7. Hors grappe, la commande est refusee.
 *   8. `execute ha synchronize start` tape sur un SECONDAIRE TIRE la
 *      configuration du primaire : un objet cree sur le primaire apres le
 *      dernier battement apparait sur le secondaire sans que le primaire
 *      ait re-emis.
 *   9. La meme commande sur le PRIMAIRE pousse, comme avant.
 *  10. Tout cela passe par de VRAIES trames sur le lien de battement :
 *      cable coupe, la voie de commande ne repond plus.
 *  11. TEMOIN : sans voie de commande ouverte, une commande tapee
 *      localement reste locale — le distant n'a rien execute.
 *
 * Discrimination (`git stash push -- src/network/`) : 6 cas sur 13
 * tombent. Les sept qui passent des DEUX cotes sont nommes ici :
 *
 *   — le montage du labo (« le primaire est FGT-A »), le TEMOIN et
 *     « sur le PRIMAIRE, elle pousse comme avant » sont des
 *     non-regressions : c'est leur role de passer des deux cotes.
 *   — « un index qui ne designe aucun membre » et « hors grappe » etaient
 *     deja refuses ; ils gardent les refus, ils ne prouvent pas la voie.
 *   — « `exit` ramene sur le membre local » et « cable coupe, rien n'est
 *     tire » passent AVANT pour une raison qui ne prouve rien : on
 *     n'etait jamais parti, et rien n'etait jamais tire.
 *
 * Un cas a ete DURCI apres discrimination : « cable coupe, la voie de
 * commande ne repond plus » passait avec `/fail/`, parce que le mot de
 * passe tape en clair etait alors une commande inconnue — donc
 * « Command fail ». Il exige desormais le message exact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const MOT_DE_PASSE_A = 'SecretLocal1';
const MOT_DE_PASSE_B = 'SecretDistant2';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Membre { fw: FortiGate; sh: FortiShell }

function membre(nom: string, lan: string, motDePasse: string): Membre {
  const fw = new FortiGate('firewall-fortinet', nom, 0, 0);
  const sh = new FortiShell(fw);
  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${lan} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
    'config system admin', 'edit "admin"',
    `set password "${motDePasse}"`, 'next', 'end');
  return { fw, sh };
}

function grappe(m: Membre, priorite: number): string {
  return run(m.sh,
    'config system ha',
    'set group-name "cluster-paris"',
    'set group-id 10',
    'set mode a-p',
    'set password "SecretHA"',
    'set hbdev "port7" 50',
    `set priority ${priorite}`,
    'end');
}

interface Labo { a: Membre; b: Membre; coeur: Cable }

function laboratoire(): Labo {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const a = membre('FGT-A', '192.168.1.1', MOT_DE_PASSE_A);
  const b = membre('FGT-B', '192.168.1.2', MOT_DE_PASSE_B);

  const coeur = new Cable('hb');
  coeur.connect(a.fw.getPort('port7')!, b.fw.getPort('port7')!);

  grappe(a, 200);
  grappe(b, 128);

  for (let tour = 0; tour < 3; tour++) {
    a.fw.getHa().tick();
    b.fw.getHa().tick();
  }
  return { a, b, coeur };
}

beforeEach(() => { Logger.reset(); });

describe('execute ha manage — la session distante est reelle', () => {
  it('le primaire est FGT-A et le secondaire FGT-B', () => {
    const { a, b } = laboratoire();

    expect(a.fw.getHa().role()).toBe('master');
    expect(b.fw.getHa().role()).toBe('slave');
  });

  it('la commande demande un mot de passe', () => {
    const { a } = laboratoire();

    expect(run(a.sh, 'execute ha manage 1 admin')).toContain('password');
  });

  it('le mot de passe est celui du membre CIBLE', () => {
    const { a } = laboratoire();
    run(a.sh, 'execute ha manage 1 admin');

    expect(run(a.sh, MOT_DE_PASSE_A)).toMatch(/denied|incorrect|fail/i);

    run(a.sh, 'execute ha manage 1 admin');
    expect(run(a.sh, MOT_DE_PASSE_B)).not.toMatch(/denied|incorrect|fail/i);
  });

  it('une fois entre, l invite est celle du membre DISTANT', () => {
    const { a } = laboratoire();
    run(a.sh, 'execute ha manage 1 admin', MOT_DE_PASSE_B);

    expect(a.sh.getPrompt()).toContain('FGT-B');
  });

  it('une commande tapee la-bas s execute LA-BAS', () => {
    const { a, b } = laboratoire();
    run(a.sh, 'execute ha manage 1 admin', MOT_DE_PASSE_B);

    const vue = run(a.sh, 'get system status');

    expect(vue).toContain(b.fw.serialNumber());
    expect(vue).not.toContain(a.fw.serialNumber());
  });

  it('`exit` ramene sur le membre local', () => {
    const { a } = laboratoire();
    run(a.sh, 'execute ha manage 1 admin', MOT_DE_PASSE_B);

    run(a.sh, 'exit');

    expect(a.sh.getPrompt()).toContain('FGT-A');
    expect(run(a.sh, 'get system status')).toContain(a.fw.serialNumber());
  });

  it('un index qui ne designe aucun membre est refuse', () => {
    const { a } = laboratoire();

    expect(run(a.sh, 'execute ha manage 9 admin')).toMatch(/no cluster member/i);
  });

  it('hors grappe, la commande est refusee', () => {
    const { a } = laboratoire();
    run(a.sh, 'config system ha', 'set mode standalone', 'end');

    expect(run(a.sh, 'execute ha manage 1 admin'))
      .toMatch(/not part of a cluster/i);
  });

  it('cable coupe, la voie de commande ne repond plus', () => {
    const { a, coeur } = laboratoire();
    coeur.disconnect();

    // Assertion serree a dessein : `/fail/` seul passait AVANT le
    // correctif, le mot de passe tape en clair etant alors une commande
    // inconnue — donc « Command fail ». Vrai pour la mauvaise raison.
    expect(run(a.sh, 'execute ha manage 1 admin', MOT_DE_PASSE_B))
      .toContain('no response from the cluster member');
    expect(a.sh.getPrompt()).toContain('FGT-A');
  });

  it('TEMOIN : sans session ouverte, la commande reste locale', () => {
    const { a } = laboratoire();

    expect(run(a.sh, 'get system status')).toContain(a.fw.serialNumber());
  });
});

describe('execute ha synchronize start — la configuration se TIRE', () => {
  it('sur un SECONDAIRE, elle tire la configuration du primaire', () => {
    const { a, b } = laboratoire();
    run(a.sh,
      'config firewall address', 'edit "APRES-COUP"',
      'set subnet 10.99.0.0 255.255.0.0', 'next', 'end');

    expect(b.sh.execute('show firewall address "APRES-COUP"'))
      .not.toContain('10.99.0.0');

    b.sh.execute('execute ha synchronize start');

    expect(b.sh.execute('show firewall address "APRES-COUP"'))
      .toContain('10.99.0.0');
  });

  it('sur le PRIMAIRE, elle pousse comme avant', () => {
    const { a, b } = laboratoire();
    run(a.sh,
      'config firewall address', 'edit "POUSSE"',
      'set subnet 10.98.0.0 255.255.0.0', 'next', 'end');

    a.sh.execute('execute ha synchronize start');

    expect(b.sh.execute('show firewall address "POUSSE"'))
      .toContain('10.98.0.0');
  });

  it('cable coupe, rien n est tire', () => {
    const { a, b, coeur } = laboratoire();
    run(a.sh,
      'config firewall address', 'edit "JAMAIS"',
      'set subnet 10.97.0.0 255.255.0.0', 'next', 'end');
    coeur.disconnect();

    b.sh.execute('execute ha synchronize start');

    expect(b.sh.execute('show firewall address "JAMAIS"'))
      .not.toContain('10.97.0.0');
  });
});
