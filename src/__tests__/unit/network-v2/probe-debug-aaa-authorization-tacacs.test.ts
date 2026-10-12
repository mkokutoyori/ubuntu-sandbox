/*
 * `debug aaa authorization` s'armait et ne disait rien : la categorie
 * `aaa.authorization` etait la derniere avec `ip.nhrp` a n'avoir aucun
 * emetteur, sous le motif « aucun evenement ne distingue l'autorisation
 * de l'authentification ».
 *
 * Le motif a cesse d'etre vrai : le client TACACS+ publie
 * `tacacs.author.completed` (utilisateur, serveur, statut, commande) et
 * `tacacs.authen.completed`. Le service de debug s'y abonne : une
 * autorisation rend `AAA/AUTHOR: user 'x' command 'y' status = PASS_ADD`
 * et une authentification TACACS+ rend `AAA/AUTHEN: status = PASS|FAIL`,
 * la meme ligne que celle que RADIUS emettait deja. Les lignes `TAC+:`
 * de `debug tacacs` couvrent maintenant authentification et autorisation,
 * et non plus la seule comptabilite.
 *
 * Le texte est derive des charges utiles des evenements ; sa forme exacte
 * sur un IOS reel n'est pas attestee depuis ce reseau. Les statuts sont
 * ecrits en majuscules avec un souligne (`PASS_ADD`), ecriture d'IOS
 * reprise de memoire.
 *
 * Defaut voisin, trouve en relisant l'abonnement RADIUS : une
 * authentification REFUSEE (radius.auth.completed, accepted = false) etait
 * tracee `Access-Accept` / `status = PASS`, car l'abonnement ignorait le
 * champ `accepted`. Il le lit maintenant.
 *
 * Avant le correctif : 4 des 7 cas tombent contre la base d avant le premier
 * correctif de ce fichier, dont 1 seul (RADIUS refuse) contre le commit qui l a
 * precede (git stash de src/network).
 * Passe aussi des deux cotes le temoin RADIUS accepte.
 * Passent des deux cotes le TEMOIN « sans debug aaa authorization, un
 * evenement d'autorisation ne trace rien » et « un evenement d'un autre
 * equipement est ignore » : le premier prouve que le laboratoire publie
 * bien sur le bus, le second est vide avant le correctif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { DomainEvent } from '@/events/types';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

interface Lab {
  readonly router: CiscoRouter;
  readonly lines: string[];
  publish(topic: string, payload: object, deviceId?: string): void;
}

async function lab(): Promise<Lab> {
  const router = new CiscoRouter('R1');
  await router.executeCommand('enable');
  const lines: string[] = [];
  collecteDebug((router as unknown as { getDebugService(): { subscribe(f: (l: string) => void): () => void } }).getDebugService(), lines);
  return {
    router,
    lines,
    publish: (topic, payload, deviceId) => {
      router.getBus().publish({
        topic, payload: { deviceId: deviceId ?? router.id, hostname: 'R1', ...payload },
      } as unknown as DomainEvent);
    },
  };
}

const author = { serverIp: '10.0.0.9', username: 'alice', status: 'pass-add', command: 'show version' };

describe('debug aaa authorization', () => {
  it('WITNESS : sans le drapeau, une autorisation ne trace rien', async () => {
    const l = await lab();
    l.publish('tacacs.author.completed', author);
    expect(l.lines).toEqual([]);
  });

  it('une autorisation TACACS+ est tracee avec son statut', async () => {
    const l = await lab();
    await l.router.executeCommand('debug aaa authorization');
    l.publish('tacacs.author.completed', author);
    expect(l.lines.join('\n')).toContain("AAA/AUTHOR: user 'alice' command 'show version' status = PASS_ADD");
  });

  it('un refus est trace FAIL', async () => {
    const l = await lab();
    await l.router.executeCommand('debug aaa authorization');
    l.publish('tacacs.author.completed', { ...author, status: 'fail' });
    expect(l.lines.join('\n')).toContain('status = FAIL');
  });

  it('debug tacacs trace l authentification et l autorisation', async () => {
    const l = await lab();
    await l.router.executeCommand('debug tacacs');
    l.publish('tacacs.authen.completed', { serverIp: '10.0.0.9', username: 'alice', status: 'pass', privLvl: 15 });
    l.publish('tacacs.author.completed', author);
    const out = l.lines.join('\n');
    expect(out).toContain('TAC+: authentication for user alice by 10.0.0.9: pass');
    expect(out).toContain('TAC+: authorization for user alice by 10.0.0.9: pass-add');
  });

  it('WITNESS : une authentification RADIUS acceptee reste tracee Access-Accept / PASS', async () => {
    const l = await lab();
    await l.router.executeCommand('debug radius');
    await l.router.executeCommand('debug aaa authentication');
    l.publish('radius.auth.completed', { serverIp: '10.0.0.7', username: 'alice', accepted: true, identifier: 1, reason: null });
    const out = l.lines.join('\n');
    expect(out).toContain('RADIUS: Received Access-Accept for user alice from 10.0.0.7');
    expect(out).toContain("AAA/AUTHEN: status = PASS for user 'alice'");
  });

  it('une authentification RADIUS refusee n est plus tracee comme acceptee', async () => {
    const l = await lab();
    await l.router.executeCommand('debug radius');
    await l.router.executeCommand('debug aaa authentication');
    l.publish('radius.auth.completed', { serverIp: '10.0.0.7', username: 'alice', accepted: false, identifier: 2, reason: 'bad-password' });
    const out = l.lines.join('\n');
    expect(out).toContain('RADIUS: Received Access-Reject for user alice from 10.0.0.7');
    expect(out).toContain("AAA/AUTHEN: status = FAIL for user 'alice'");
    expect(out).not.toContain('Access-Accept');
  });

  it('un evenement d un autre equipement est ignore', async () => {
    const l = await lab();
    await l.router.executeCommand('debug aaa authorization');
    l.publish('tacacs.author.completed', author, 'other');
    expect(l.lines).toEqual([]);
  });
});
