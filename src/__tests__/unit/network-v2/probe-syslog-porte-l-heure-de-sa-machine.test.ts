/**
 * Lot T8 du `docs/PRD-Geographie-Et-Temps-Local.md` : ce qui part sur le
 * FIL porte l'heure de la machine qui l'emet (invariant I-T5).
 *
 * ── Ce qui a ete mesure avant correctif ──────────────────────────────
 *
 * Un routeur regle sur `Europe/Paris` (`clock timezone CET 1` +
 * `clock summer-time`), horloge posee au 15 juillet 2026 a midi, qui
 * envoie un message a son collecteur :
 *
 *     show clock     *14:00:00.000 CEST Wed Jul 15 2026
 *     sur le fil     Sep 10 10:38:02
 *
 * DEUX MOIS d'ecart, au meme instant, pour la meme machine. Le datagramme
 * portait `bsdTimestamp(Date.now())` — l'horloge du navigateur qui
 * execute le simulateur. `clock set` n'atteignait donc pas le fil, et un
 * laboratoire qui regle l'heure pour etudier une correlation de journaux
 * enseignait le contraire de ce qu'il montrait.
 *
 * **Le second site est FortiOS.** `rfc5424Line` horodatait par
 * `new Date(record.at).toISOString()`, qui rend TOUJOURS un `Z` :
 *
 *     AVANT   <188>1 2026-07-15T12:00:00.000Z FGT FortiGate - …
 *     APRES   <188>1 2026-07-15T14:00:00.000+02:00 FGT FortiGate - …
 *
 * La RFC 5424 §6.2.3 admet les deux formes, mais un boitier qui a un
 * fuseau envoie SON decalage ; rendre `Z` en pretendant l'heure locale
 * est ce que faisait le rendu, puisque `record.at` est un instant UTC
 * et que rien ne le decalait. C'est la meme faute que du cote Cisco,
 * dans l'autre sens : l'un ignorait l'horloge, l'autre le fuseau.
 *
 * ── Un seul rendu, pas deux ─────────────────────────────────────────
 *
 * `rfc5424Timestamp` vit dans `core/time/DeviceClock` avec le reste du
 * socle temporel, et non dans le dossier FortiOS : le format est celui
 * de la RFC, pas celui d'un constructeur, et le prochain emetteur qui en
 * aura besoin le trouvera la plutot que d'en ecrire un second (§2).
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Mesure : `git stash push -- src/network` fait tomber **7 des 8 cas**.
 * Le compte est flatteur si on le prend brut, et voici pourquoi.
 *
 * QUATRE tombent pour la bonne raison : ce sont les cas du FIL, et ils
 * rendaient tous `Sep 10 10:44:27` — la date reelle du jour — la ou la
 * machine etait au 15 juillet. Ils mordent sur le defaut.
 *
 * TROIS tombent pour une raison de STRUCTURE : `rfc5424Timestamp`
 * n'existe pas avant le lot, donc le module ne se charge pas et les cas
 * ne peuvent pas passer. Ils ne prouvent aucun defaut ferme ; ils posent
 * le CONTRAT du format, y compris le cas `Z` qui, lui, etait deja juste
 * avant. Les compter comme des defauts fermes serait se faire un
 * compliment.
 *
 * Le cas qui passe des DEUX cotes est le TEMOIN, et il est
 * indispensable : « un datagramme syslog atteint bien le collecteur ».
 * Sans lui, un laboratoire casse — un cable oublie, une adresse jamais
 * posee, un cache ARP froid — et un horodatage faux seraient
 * indiscernables, puisque les deux rendent `null`. Il a d'ailleurs servi
 * pendant l'ecriture : la premiere version de cette sonde importait
 * `UDP_PORT_SYSLOG` du mauvais module, le filtre comparait a `undefined`
 * et TOUT rendait `null` — c'est le temoin qui l'a dit, pas les cas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { UDP_PORT_SYSLOG } from '@/network/syslog/types';
import { rfc5424Timestamp } from '@/network/core/time/DeviceClock';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function jouer(
  d: { executeCommand(c: string): Promise<string> }, lignes: string[],
): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

interface Laboratoire {
  readonly routeur: CiscoRouter;
  readonly surLeFil: () => string | null;
}

async function laboratoire(reglages: readonly string[]): Promise<Laboratoire> {
  const bus = new EventBus();
  const routeur = new CiscoRouter('R1');
  const collecteur = new CiscoRouter('SRV');
  const commutateur = new CiscoSwitch('switch-cisco', 'SW', 4);
  routeur.setEventBus(bus);
  collecteur.setEventBus(bus);
  commutateur.setEventBus(bus);

  const lien = new Cable('c');
  lien.setEventBus(bus);
  lien.connect(routeur.getPort('GigabitEthernet0/0')!,
    commutateur.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(collecteur.getPort('GigabitEthernet0/0')!,
    commutateur.getPort('FastEthernet0/2')!);

  let vu: string | null = null;
  bus.subscribe('cable.frame.delivered', (e) => {
    const paquet = (e.payload.frame.payload as unknown) as {
      payload?: {
        type?: string; destinationPort?: number;
        payload?: { type?: string; timestamp?: string };
      };
    } | undefined;
    const datagramme = paquet?.payload;
    if (datagramme?.type === 'udp'
        && datagramme.destinationPort === UDP_PORT_SYSLOG
        && datagramme.payload?.type === 'syslog') {
      vu = datagramme.payload.timestamp ?? null;
    }
  });

  await jouer(routeur, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit', ...reglages, 'end']);
  await jouer(collecteur, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.99 255.255.255.0',
    'no shutdown', 'end']);
  await routeur.executeCommand('ping 10.0.0.99');

  routeur.getSyslogAgent().addServer('10.0.0.99');
  return { routeur, surLeFil: () => vu };
}

const PARIS = [
  'clock timezone CET 1',
  'clock summer-time CEST recurring last Sun Mar 2:00 last Sun Oct 3:00',
];

function emettre(lab: Laboratoire): void {
  lab.routeur.getSyslogAgent().sendImmediate(
    'notification', '%SYS-5-RESTART', 'Configuration changed');
}

describe('le syslog porte l_heure de sa machine', () => {
  it('la date sur le fil est celle que clock set a posee', async () => {
    const lab = await laboratoire(PARIS);
    await lab.routeur.executeCommand('clock set 12:00:00 15 Jul 2026');

    emettre(lab);

    expect(lab.surLeFil()).toContain('Jul 15');
  }, 60000);

  it('et l_heure est l_heure LOCALE, pas UTC', async () => {
    const lab = await laboratoire(PARIS);
    await lab.routeur.executeCommand('clock set 12:00:00 15 Jul 2026');

    emettre(lab);

    expect(lab.surLeFil()).toBe('Jul 15 14:00:00');
  }, 60000);

  it('en hiver elle suit le fuseau standard', async () => {
    const lab = await laboratoire(PARIS);
    await lab.routeur.executeCommand('clock set 12:00:00 15 Jan 2026');

    emettre(lab);

    expect(lab.surLeFil()).toBe('Jan 15 13:00:00');
  }, 60000);

  it('sans fuseau configure, le fil reste en UTC', async () => {
    const lab = await laboratoire([]);
    await lab.routeur.executeCommand('clock set 12:00:00 15 Jul 2026');

    emettre(lab);

    expect(lab.surLeFil()).toBe('Jul 15 12:00:00');
  }, 60000);

  it('TEMOIN — un datagramme syslog atteint bien le collecteur', async () => {
    const lab = await laboratoire(PARIS);

    emettre(lab);

    expect(lab.surLeFil()).not.toBeNull();
  }, 60000);
});

describe('l_horodatage RFC 5424 porte son decalage', () => {
  it('un decalage positif se rend comme la RFC l_ecrit', () => {
    expect(rfc5424Timestamp(Date.UTC(2026, 6, 15, 14, 0, 0), 120))
      .toBe('2026-07-15T14:00:00.000+02:00');
  });

  it('un decalage negatif aussi, minutes comprises', () => {
    expect(rfc5424Timestamp(Date.UTC(2026, 0, 15, 8, 30, 0), -210))
      .toBe('2026-01-15T08:30:00.000-03:30');
  });

  it('UTC garde le Z que la RFC lui reserve', () => {
    expect(rfc5424Timestamp(Date.UTC(2026, 0, 15, 12, 0, 0), 0))
      .toBe('2026-01-15T12:00:00.000Z');
  });
});
