/**
 * `firewall DoS-policy` mesure une anomalie, et la mesure decide.
 *
 * Ecrit A L'AVEUGLE, contre `official_docs/forti-cli-ref-60.txt`
 * p. 191-193 et les valeurs par defaut relevees sur de vraies machines.
 *
 * La reference definit QUATRE anomalies statistiques, et elles ne
 * mesurent pas la meme chose — c'est le point qu'il ne faut pas rater :
 *
 *   « Flooding : if the number of sessions targeting a single
 *     DESTINATION in one second is over a threshold. »
 *   « Scan : if the number of sessions from a single SOURCE in one
 *     second is over a threshold. »
 *   « Source session limit : if the number of CONCURRENT sessions from a
 *     single source is over a threshold. »
 *   « Destination session limit : … CONCURRENT sessions to a single
 *     destination. »
 *
 * Les deux premieres sont un DEBIT (par seconde), les deux dernieres un
 * ETAT INSTANTANE (le nombre de sessions ouvertes). Les confondre
 * donnerait une machine qui bloque au bon moment pour la mauvaise
 * raison, donc un laboratoire qui n'apprend rien. Les deux familles sont
 * eprouvees separement.
 *
 * Faits releves plutot que supposes : le seuil est en PAQUETS PAR
 * SECONDE, `tcp_syn_flood` vaut 2000 par defaut, `icmp_flood` 250,
 * `icmp_sweep` 100, les familles `*_session` 5000 (sauf
 * `icmp_src_session` 300 et `icmp_dst_session` 1000), et TOUTES les
 * anomalies sont livrees DESACTIVEES avec l'action `pass`. La liste des
 * anomalies est fixe — la reference ecrit « The list of anomalies can be
 * updated only when the FortiGate firmware image is upgraded » — donc un
 * nom invente doit etre refuse.
 *
 * Les TEMOINS portent dans les deux sens : sans politique DoS une rafale
 * passe entierement, et une anomalie desactivee ou en action `pass` la
 * laisse passer aussi — sans quoi un blocage general passerait pour un
 * progres.
 *
 * Discrimination : 6 cas tombent contre l'etat d'avant le lot ; en
 * retirant seulement l'etage `dos-policy` de l'ordre declare par
 * `FortiProfile`, 2 tombent — exactement les deux qui observent un
 * blocage, l'un par debit et l'autre par sessions concurrentes. Les
 * autres relevent du schema et du journal, pas de la porte. Les cas qui
 * passent des deux cotes sont les TEMOINS, et ils passent AUSSI avant le
 * lot parce qu'une fonction absente ne bloque rien : ils gardent le
 * correctif contre un exces de zele, ils ne prouvent pas la fonction.
 *
 * DEFAUT DE LA SONDE trouve en la relisant, ecrit ici plutot que tu : la
 * premiere version envoyait dix echos a 0,2 s d'intervalle et attendait
 * « 3 received » sous un seuil de 3. Elle avait tort — la rafale dure
 * plus d'une seconde, donc la fenetre repart et laisse passer d'autres
 * paquets, ce qui est le comportement JUSTE d'un seuil par seconde.
 * L'assertion mesurait un debit sur une duree qu'elle ne controlait pas.
 * Les deux cas actuels tiennent chacun un cote du contrat : deux echos
 * rapproches sous un seuil de 1 (un seul passe), et deux echos espaces
 * de plus d'une seconde (les deux passent).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function run(sh: FortiShell, ...lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) out.push(sh.execute(line));
  return out.filter(o => o !== '').join('\n');
}

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const pcA = new LinuxPC('linux-pc', 'PCA', 200, 0);
  const pcB = new LinuxPC('linux-pc', 'PCB', 400, 0);
  const pcC = new LinuxPC('linux-pc', 'PCC', 400, 200);
  for (const pc of [pcA, pcB, pcC]) pc.powerOn();

  new Cable('c1').connect(fw.getPort('port1')!, pcA.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, pcB.getPorts()[0]);
  new Cable('c3').connect(fw.getPort('port3')!, pcC.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.0.1 255.255.255.0', 'next',
    'edit "port3"', 'set mode static', 'set ip 10.3.0.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set schedule "always"', 'set action accept', 'next',
    'edit 2', 'set srcintf "port1"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set schedule "always"', 'set action accept', 'next', 'end');

  await runOn(pcA, 'ip link set eth0 up', 'ip addr add 10.1.0.10/24 dev eth0',
    'ip route add default via 10.1.0.1');
  await runOn(pcB, 'ip link set eth0 up', 'ip addr add 10.2.0.10/24 dev eth0',
    'ip route add default via 10.2.0.1');
  await runOn(pcC, 'ip link set eth0 up', 'ip addr add 10.3.0.10/24 dev eth0',
    'ip route add default via 10.3.0.1');

  return { fw, sh, pcA, pcB, pcC };
}

function anomalieIcmpFlood(sh: FortiShell, seuil: number, action: string): string {
  return run(sh, 'config firewall DoS-policy', 'edit 1',
    'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"',
    'config anomaly', 'edit "icmp_flood"',
    'set status enable', `set action ${action}`, `set threshold ${seuil}`,
    'next', 'end', 'next', 'end');
}

const TOUT_PASSE = /, 0% packet loss/;

describe('sans politique DoS, la rafale passe entiere', () => {
  it('TEMOIN: dix echos traversent', async () => {
    const { pcA } = await laboratoire();

    expect(await runOn(pcA, 'ping -c 10 -i 0.2 10.2.0.10')).toMatch(TOUT_PASSE);
  });
});

describe('un DEBIT au-dela du seuil est bloque', () => {
  it('icmp_flood a 1 laisse passer un echo et bloque le suivant', async () => {
    const { sh, pcA } = await laboratoire();
    anomalieIcmpFlood(sh, 1, 'block');

    const sortie = await runOn(pcA, 'ping -c 2 -i 0.2 10.2.0.10');

    expect(sortie).toMatch(/2 packets transmitted, 1 received/);
  });

  it('le compteur est PAR SECONDE — la fenetre suivante repart a zero', async () => {
    const { sh, pcA } = await laboratoire();
    anomalieIcmpFlood(sh, 1, 'block');

    const sortie = await runOn(pcA, 'ping -c 2 -i 1.2 10.2.0.10');

    expect(sortie).toMatch(TOUT_PASSE);
  });

  it('TEMOIN: la meme anomalie DESACTIVEE laisse tout passer', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy', 'edit 1',
      'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"',
      'set status disable', 'set action block', 'set threshold 3',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping -c 10 -i 0.2 10.2.0.10')).toMatch(TOUT_PASSE);
  });

  it('TEMOIN: l action `pass` laisse passer meme au-dela du seuil', async () => {
    const { sh, pcA } = await laboratoire();
    anomalieIcmpFlood(sh, 3, 'pass');

    expect(await runOn(pcA, 'ping -c 10 -i 0.2 10.2.0.10')).toMatch(TOUT_PASSE);
  });

  it('l anomalie ne vaut que sur l interface nommee', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy', 'edit 1',
      'set interface "port3"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"',
      'set status enable', 'set action block', 'set threshold 3',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping -c 10 -i 0.2 10.2.0.10')).toMatch(TOUT_PASSE);
  });

  it('une anomalie UDP ne juge pas du trafic ICMP', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy', 'edit 1',
      'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"',
      'config anomaly', 'edit "udp_flood"',
      'set status enable', 'set action block', 'set threshold 1',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping -c 10 -i 0.2 10.2.0.10')).toMatch(TOUT_PASSE);
  });
});

describe('une limite de SESSION compte les sessions ouvertes, pas un debit', () => {
  it('icmp_src_session a 1 bloque la deuxieme destination', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy', 'edit 1',
      'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_src_session"',
      'set status enable', 'set action block', 'set threshold 1',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping -c 1 10.2.0.10')).toMatch(TOUT_PASSE);
    expect(await runOn(pcA, 'ping -c 1 10.3.0.10')).not.toMatch(TOUT_PASSE);
  });

  it('TEMOIN: sous un seuil large les deux destinations repondent', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy', 'edit 1',
      'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_src_session"',
      'set status enable', 'set action block', 'set threshold 100',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping -c 1 10.2.0.10')).toMatch(TOUT_PASSE);
    expect(await runOn(pcA, 'ping -c 1 10.3.0.10')).toMatch(TOUT_PASSE);
  });
});

describe('`set log enable` ecrit un vrai journal d anomalie', () => {
  it('le blocage parait dans le journal UTM sous le sous-type anomaly', async () => {
    const { fw, sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy', 'edit 1',
      'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"',
      'set status enable', 'set action block', 'set log enable', 'set threshold 1',
      'next', 'end', 'next', 'end');

    await runOn(pcA, 'ping -c 2 -i 0.2 10.2.0.10');

    const journal = fw.getLogStore().all()
      .filter(e => e.type === 'utm' && e.subtype === 'anomaly');
    expect(journal.length).toBeGreaterThan(0);
    expect(journal[0].fields.get('attack')).toBe('icmp_flood');
    expect(journal[0].fields.get('srcip')).toBe('10.1.0.10');
  });

  it('TEMOIN: sans `set log enable`, rien n est ecrit', async () => {
    const { fw, sh, pcA } = await laboratoire();
    anomalieIcmpFlood(sh, 1, 'block');

    await runOn(pcA, 'ping -c 2 -i 0.2 10.2.0.10');

    expect(fw.getLogStore().all()
      .filter(e => e.type === 'utm' && e.subtype === 'anomaly')).toEqual([]);
  });
});

describe('la liste des anomalies est celle du micrologiciel', () => {
  it('les dix-huit noms attestes sont acceptes', async () => {
    const { sh } = await laboratoire();
    const noms = [
      'tcp_syn_flood', 'tcp_port_scan', 'tcp_src_session', 'tcp_dst_session',
      'udp_flood', 'udp_scan', 'udp_src_session', 'udp_dst_session',
      'icmp_flood', 'icmp_sweep', 'icmp_src_session', 'icmp_dst_session',
      'ip_src_session', 'ip_dst_session',
      'sctp_flood', 'sctp_scan', 'sctp_src_session', 'sctp_dst_session',
    ];

    run(sh, 'config firewall DoS-policy', 'edit 1', 'config anomaly');
    const refus = noms.map(nom => run(sh, `edit "${nom}"`, 'next'));
    run(sh, 'end', 'next', 'end');

    expect(refus.filter(r => /Command fail|does not exist/.test(r))).toEqual([]);
  });

  it('un nom d anomalie invente est refuse', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall DoS-policy', 'edit 1', 'config anomaly');
    const refuse = run(sh, 'edit "zorglub_flood"');

    expect(refuse).toMatch(/Command fail|does not exist/);
  });

  it('l action `proxy` est refusee en nommant ce qui manque', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall DoS-policy', 'edit 1', 'config anomaly',
      'edit "icmp_flood"');
    const refuse = run(sh, 'set action proxy');

    expect(refuse).toMatch(/Command fail/);
    expect(refuse).toMatch(/proxy/);
  });
});

describe('la configuration se relit', () => {
  it('show firewall DoS-policy rend ce qui a ete tape', async () => {
    const { sh } = await laboratoire();
    anomalieIcmpFlood(sh, 3, 'block');

    const out = run(sh, 'show firewall DoS-policy');

    expect(out).toContain('config firewall DoS-policy');
    expect(out).toContain('set interface "port1"');
    expect(out).toContain('config anomaly');
    expect(out).toContain('edit "icmp_flood"');
    expect(out).toContain('set status enable');
    expect(out).toContain('set threshold 3');
  });

  it('les seuils par defaut sont ceux des vraies machines', async () => {
    const { fw } = await laboratoire();
    const defauts = fw.dosAnomalyDefaults();

    expect(defauts.get('tcp_syn_flood')).toBe(2000);
    expect(defauts.get('icmp_flood')).toBe(250);
    expect(defauts.get('icmp_sweep')).toBe(100);
    expect(defauts.get('icmp_src_session')).toBe(300);
    expect(defauts.get('icmp_dst_session')).toBe(1000);
    expect(defauts.get('tcp_src_session')).toBe(5000);
  });
});
