/**
 * Lot T4 du `docs/PRD-Geographie-Et-Temps-Local.md`, premiere piece : le
 * socle qui EVALUE une regle d'heure d'ete, la ou le depot se contentait
 * jusqu'ici de l'analyser, de la valider et de la reafficher.
 *
 * `clock summer-time` etait le cas d'ecole du `CLAUDE.md` §6 : la
 * grammaire est jugee au jeton pres par `clockSummerTime.ts`, la regle
 * est rangee, `show running-config` la relit — et `ciscoClockReading`
 * n'ajoutait que `offsetMin`. Toutes les apparences d'exister sauf
 * l'effet, et `show clock` faux six mois sur douze.
 *
 * **Une horloge d'equipement n'est PAS un fuseau IANA**, et c'est
 * pourquoi ce socle ne delegue pas au registre du lot T1. Ce que
 * l'operateur ecrit est sa PROPRE regle — `clock timezone CET 1` puis
 * `clock summer-time CEST recurring last Sun Mar 2:00 last Sun Oct 3:00`
 * — et un equipement l'applique telle quelle, meme si elle ne
 * correspond a aucune zone reelle. Deriver `Europe/Paris` de `CET`
 * serait repondre a une autre question que celle qui a ete posee.
 *
 * ── Autorites, et ce qui n'a PAS pu etre source ──────────────────────
 *
 * `cisco.com` et `support.huawei.com` sont tous deux INJOIGNABLES depuis
 * cet environnement (proxy de sortie). Ce qui suit distingue donc ce qui
 * est etabli de ce qui est assume.
 *
 * ETABLI, par deux rendus secondaires concordants de la reference IOS
 * (« Basic System Management Command Reference » et le « Cisco IOS
 * Cookbook » d'O'Reilly) : `clock summer-time <zone> recurring` SANS
 * parametres prend les regles americaines — premier dimanche d'avril
 * 02:00 au dernier dimanche d'octobre 02:00 — et le decalage par defaut
 * vaut 60 minutes.
 *
 * ASSUME, faute de source atteignable : la convention de BORD. L'heure
 * de debut s'entend ici en heure STANDARD et l'heure de fin en heure
 * d'ETE, ce qui est la convention de tzdata et des textes americains et
 * europeens. Elle ne change le verdict que pendant l'heure meme de
 * bascule ; elle est inscrite au `TODO.md` en attendant qu'une source
 * constructeur puisse la confirmer.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Cette sonde ne discrimine RIEN par `git stash` et c'est assume : elle
 * decrit le contrat d'un module NEUF, que rien n'importe encore. Sa
 * valeur est a venir — c'est le contrat sur lequel `show clock` et
 * `display clock` viendront se brancher dans la suite du lot, et les cas
 * qui mordront seront ceux-la. Le dire ici evite de compter douze cas
 * verts comme douze defauts fermes.
 */
import { describe, it, expect } from 'vitest';
import {
  clockReadingAt, type DeviceClockConfig,
} from '@/network/core/time/DeviceClock';

const BASE: DeviceClockConfig = {
  timezone: 'UTC',
  offsetMin: 0,
  summerTimezone: '',
  summerKind: 'recurring',
  daylightStart: '',
  daylightEnd: '',
  daylightOffsetMin: 60,
};

const paris = (extra: Partial<DeviceClockConfig> = {}): DeviceClockConfig => ({
  ...BASE, timezone: 'CET', offsetMin: 60, ...extra,
});

const parisEnEte = (extra: Partial<DeviceClockConfig> = {}): DeviceClockConfig =>
  paris({
    summerTimezone: 'CEST',
    daylightStart: 'last Sun Mar 2:00',
    daylightEnd: 'last Sun Oct 3:00',
    ...extra,
  });

const JANVIER = Date.UTC(2026, 0, 15, 12, 0, 0);
const JUILLET = Date.UTC(2026, 6, 15, 12, 0, 0);

const heureLocale = (config: DeviceClockConfig, atMs: number): number =>
  new Date(clockReadingAt(config, atMs).localMs).getUTCHours();

describe('l_horloge d_un equipement', () => {
  it('sans regle, elle n_applique que son decalage', () => {
    expect(heureLocale(paris(), JANVIER)).toBe(13);
    expect(heureLocale(paris(), JUILLET)).toBe(13);
  });

  it('avec une regle, elle avance en ete et pas en hiver', () => {
    expect(heureLocale(parisEnEte(), JANVIER)).toBe(13);
    expect(heureLocale(parisEnEte(), JUILLET)).toBe(14);
  });

  it('elle porte le NOM d_ete quand elle est en ete', () => {
    expect(clockReadingAt(parisEnEte(), JANVIER).zoneName).toBe('CET');
    expect(clockReadingAt(parisEnEte(), JUILLET).zoneName).toBe('CEST');
  });

  it('elle dit si elle est en heure d_ete', () => {
    expect(clockReadingAt(parisEnEte(), JANVIER).inSummer).toBe(false);
    expect(clockReadingAt(parisEnEte(), JUILLET).inSummer).toBe(true);
  });

  it('le decalage rendu est celui qui s_applique vraiment', () => {
    expect(clockReadingAt(parisEnEte(), JANVIER).offsetMin).toBe(60);
    expect(clockReadingAt(parisEnEte(), JUILLET).offsetMin).toBe(120);
  });

  it('un decalage d_ete autre que soixante minutes est honore', () => {
    const deuxHeures = parisEnEte({ daylightOffsetMin: 120 });

    expect(clockReadingAt(deuxHeures, JUILLET).offsetMin).toBe(180);
    expect(heureLocale(deuxHeures, JUILLET)).toBe(15);
  });

  it('`recurring` sans bornes prend les regles americaines', () => {
    const newYork: DeviceClockConfig = {
      ...BASE, timezone: 'EST', offsetMin: -300, summerTimezone: 'EDT',
    };

    expect(clockReadingAt(newYork, Date.UTC(2026, 5, 15, 12)).zoneName).toBe('EDT');
    expect(clockReadingAt(newYork, Date.UTC(2026, 0, 15, 12)).zoneName).toBe('EST');
    expect(clockReadingAt(newYork, Date.UTC(2026, 2, 1, 12)).zoneName).toBe('EST');
    expect(clockReadingAt(newYork, Date.UTC(2026, 10, 15, 12)).zoneName).toBe('EST');
  });

  it('`last Sun Mar` tombe bien le 29 mars 2026', () => {
    const veille = Date.UTC(2026, 2, 28, 12, 0, 0);
    const lendemain = Date.UTC(2026, 2, 30, 12, 0, 0);

    expect(clockReadingAt(parisEnEte(), veille).inSummer).toBe(false);
    expect(clockReadingAt(parisEnEte(), lendemain).inSummer).toBe(true);
  });

  it('une regle DATEE ne vaut que pour son annee', () => {
    const datee = paris({
      summerTimezone: 'CEST', summerKind: 'date',
      daylightStart: '25 Mar 2026 2:00', daylightEnd: '25 Oct 2026 3:00',
    });

    expect(clockReadingAt(datee, JUILLET).inSummer).toBe(true);
    expect(clockReadingAt(datee, Date.UTC(2027, 6, 15, 12)).inSummer).toBe(false);
  });

  it('l_hemisphere sud enjambe le nouvel an', () => {
    const sydney = paris({
      timezone: 'AEST', offsetMin: 600, summerTimezone: 'AEDT',
      daylightStart: 'first Sun Oct 2:00', daylightEnd: 'first Sun Apr 3:00',
    });

    expect(clockReadingAt(sydney, JANVIER).inSummer).toBe(true);
    expect(clockReadingAt(sydney, JUILLET).inSummer).toBe(false);
  });

  it('une regle illisible laisse l_heure standard, elle ne casse pas', () => {
    const bancale = paris({
      summerTimezone: 'CEST', daylightStart: 'zorglub', daylightEnd: 'zorglub',
    });

    expect(clockReadingAt(bancale, JUILLET).inSummer).toBe(false);
    expect(clockReadingAt(bancale, JUILLET).offsetMin).toBe(60);
  });

  it('un decalage negatif se lit dans le bon sens', () => {
    const losAngeles: DeviceClockConfig = { ...BASE, timezone: 'PST', offsetMin: -480 };

    expect(heureLocale(losAngeles, Date.UTC(2026, 0, 15, 12))).toBe(4);
  });
});
