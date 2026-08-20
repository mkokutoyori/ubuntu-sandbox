import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { AaaAuthenticator } from '@/network/devices/router/aaa/AaaAuthenticator';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routeur(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  r.powerOn?.();
  await r.executeCommand('enable');
  return r;
}

describe('une machine n\'a qu\'une horloge', () => {
  it('`show calendar` suit `clock set` et `clock timezone`', async () => {
    const r = await routeur();
    await r.executeCommand('clock set 10:00:00 1 Jan 2026');
    expect(await r.executeCommand('show calendar')).toContain('10:00:00 UTC Thu Jan 1 2026');
    await r.executeCommand('configure terminal');
    await r.executeCommand('clock timezone CET 1');
    await r.executeCommand('end');
    const horloge = await r.executeCommand('show clock');
    const calendrier = await r.executeCommand('show calendar');
    expect(horloge).toContain('11:00:00');
    expect(calendrier).toContain('11:00:00');
    expect(calendrier).toContain('CET');
  }, 30_000);

  it('le calendrier ne porte pas le `*` de l\'horloge système', async () => {
    const r = await routeur();
    expect(await r.executeCommand('show clock')).toMatch(/^\*/);
    expect(await r.executeCommand('show calendar')).not.toMatch(/^\*/);
  }, 30_000);
});

describe('les valeurs affichées sont celles d\'un ISR 2911', () => {
  it('l\'uptime se compte en minutes, jamais en secondes', async () => {
    const r = await routeur();
    const version = await r.executeCommand('show version');
    expect(version).toMatch(/uptime is 0 minutes/);
    expect(version).not.toMatch(/uptime is \d+ seconds?/);
  }, 30_000);

  it('la table de routage annonce 4 chemins, pas 32', async () => {
    const r = await routeur();
    const resume = await r.executeCommand('show ip route summary');
    expect(resume).toContain('IP routing table maximum-paths is 4');
  }, 30_000);

  it('`show ntp associations` rend l\'en-tête puis la légende, sans phrase inventée', async () => {
    const r = await routeur();
    const lignes = (await r.executeCommand('show ntp associations')).split('\n');
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toContain('address');
    expect(lignes[1]).toContain('sys.peer');
    expect(lignes.join('\n')).not.toContain('No NTP associations configured');
  }, 30_000);
});

describe('la pile IP répond sur sa propre boucle locale', () => {
  it('`ping 127.0.0.1` réussit sur une machine sans aucune interface configurée', async () => {
    const r = await routeur();
    const out = await r.executeCommand('ping 127.0.0.1');
    expect(out).toContain('Success rate is 100 percent');
  }, 30_000);

  it('et toute l\'étendue 127.0.0.0/8 répond, pas seulement 127.0.0.1', async () => {
    const r = await routeur();
    expect(await r.executeCommand('ping 127.55.1.9')).toContain('Success rate is 100 percent');
  }, 30_000);
});

/**
 * Le rapport listait « aaa new-model sans effet ». La mesure dit le
 * contraire, et ce test la fige : sans le modèle, une liste de méthodes
 * est ignorée et la base locale authentifie ; avec, la liste tourne
 * vraiment et le groupe RADIUS est consulté. Le constat était faux.
 */
describe('`aaa new-model` décide quelle authentification tourne', () => {
  it('sans lui, la liste de méthodes est ignorée ; avec lui, elle tourne', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('username bob privilege 15 secret cisco');
    await r.executeCommand('aaa authentication login default group radius');
    await r.executeCommand('end');
    const auth = new AaaAuthenticator(r);

    const sans = await auth.authenticate('bob', 'cisco');
    expect(sans.accepted).toBe(true);
    expect(sans.method).toBe('local');

    await r.executeCommand('configure terminal');
    await r.executeCommand('aaa new-model');
    await r.executeCommand('end');
    const avec = await auth.authenticate('bob', 'cisco');
    expect(avec.method).not.toBe('local');
  }, 30_000);
});
