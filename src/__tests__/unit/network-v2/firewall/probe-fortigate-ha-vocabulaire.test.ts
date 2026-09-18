/**
 * Les vues de grappe parlaient le vocabulaire de FortiOS 5.6 sur une
 * machine qui annonce 7.6.3, et `get system status' taisait la grappe.
 *
 * MESURE DE DEPART sur `cd9a4db7', deux FortiGate cables et battus
 * jusqu'a l'election :
 *
 *   get system ha status   Master selected using:
 *                          Master: FGT-A, FGVMEV..., cluster index = 0
 *   get system status      Current HA mode: a-p
 *
 * AUTORITE : les SEPT captures de `get system ha status' et les QUATRE de
 * `get system status' que `ntc-templates' conserve. Elles couvrent 5.6 a
 * 7.0, et le vocabulaire CHANGE a la 7.0 — ce que le lot precedent, qui
 * comparait a la capture 5.6, n'avait pas vu :
 *
 *   5.6 / 6.x      Master selected using:
 *                  Master: fgt-200d_a, FG200Dxxxxxxxxxx, cluster index = 1
 *   7.0            Primary selected using:
 *                  Primary : FGT-fw-a, FGT40FXXXXXXXXXX, HA cluster index = 1
 *                  Secondary : FGT-fw-b, FGT40FYYYYYYYYYY, HA cluster index = 0
 *
 * Trois mots changent ensemble, et les DEUX captures de 7.0 s'accordent
 * sur les trois : `Primary' remplace `Master', `Secondary' remplace
 * `Slave ', et l'index devient `HA cluster index'. Cet equipement annonce
 * `v7.6.3' par `get system status' : c'est donc ce vocabulaire-la qu'il
 * doit parler.
 *
 * CE SUR QUOI LES DEUX CAPTURES DE 7.0 NE S'ACCORDENT PAS : le
 * remplissage. L'une ecrit `Primary     : FGT-fw-a       ,' — libelle cale
 * sur douze, nom d'hote sur quinze — l'autre `Primary : FGT-fw-a,' sans
 * aucun remplissage. Les captures 5.6 et 6.0 divergent de la meme facon
 * entre elles. Rien ne permet de deduire la regle, donc on prend la forme
 * SIMPLE, celle qui ne remplit rien, et on le dit.
 *
 * `get system status' PORTE AUSSI LA GRAPPE, et ses quatre captures le
 * fixent sans ambiguite : `Current HA mode:' y porte le mode ET le role —
 * `a-p, master' en 6.x, `a-p, primary' en 7.0 — suivi de deux lignes que
 * l'AUTONOME n'a pas du tout :
 *
 *   Current HA mode: a-p, primary
 *   Cluster uptime: 85 days, 12 hours, 38 minutes, 8 seconds
 *   Cluster state change time: 2024-07-29 03:45:36
 *
 * La duree y est ecrite en toutes lettres et separee par des virgules, la
 * ou `get system ha status' ecrit `913 days 6:17:44' pour le MEME fait.
 * Deux formes pour une meme duree sur la vraie machine : on rend chacune
 * comme elle est attestee, sans en choisir une pour les deux.
 *
 * MESURE : 7 cas tombent sur 9.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : la grappe monte vraiment et designe un primaire. Sans lui,
 *     « le vocabulaire est faux » et « aucune election n'a eu lieu »
 *     seraient indiscernables, aucune ligne de role n'etant alors ecrite ;
 *   - « un AUTONOME n'a aucune ligne de grappe » etait deja vrai, faute
 *     de rendre ces lignes du tout. C'est une garde de DECISION : en les
 *     ajoutant pour la grappe, il etait facile de les ajouter pour tous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function pareFeu(nom: string, x: number): FortiGate {
  const fgt = new FortiGate('firewall-fortinet', nom, x, 0);
  fgt.powerOn();
  return fgt;
}

async function adhere(fgt: FortiGate, priorite: number): Promise<void> {
  await taper(fgt, [
    'config system ha', 'set group-name "cluster-paris"', 'set group-id 10',
    'set mode a-p', 'set password "SecretHA"', 'set hbdev "port7" 50',
    `set priority ${priorite}`, 'end',
  ]);
}

async function grappe(): Promise<{ a: FortiGate; b: FortiGate }> {
  const a = pareFeu('FGT-A', 0);
  const b = pareFeu('FGT-B', 200);
  new Cable('hb').connect(a.getPort('port7')!, b.getPort('port7')!);
  await adhere(a, 200);
  await adhere(b, 128);
  for (let tour = 0; tour < 3; tour += 1) { a.getHa().tick(); b.getHa().tick(); }
  return { a, b };
}

const ha = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get system ha status').then(String);
const statut = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get system status').then(String);

describe('les vues de grappe parlent le vocabulaire de la version annoncee', () => {
  it('TEMOIN : la grappe monte et designe un primaire', async () => {
    const { a } = await grappe();
    expect(a.getHa().role()).toBe('master');
  }, 30000);

  it('l election est annoncee par `Primary selected using:`', async () => {
    const { a } = await grappe();
    const lignes = (await ha(a)).split('\n');

    expect(lignes).toContain('Primary selected using:');
    expect(lignes).not.toContain('Master selected using:');
  }, 30000);

  it('les membres sont nommes `Primary` et `Secondary`', async () => {
    const { a } = await grappe();
    const vue = await ha(a);

    expect(vue).toMatch(/^Primary : FGT-A, /m);
    expect(vue).not.toMatch(/^Master: /m);
    expect(vue).not.toMatch(/^Slave /m);
  }, 30000);

  it('l index porte son prefixe `HA`', async () => {
    const { a } = await grappe();
    const vue = await ha(a);

    expect(vue).toMatch(/HA cluster index = \d/);
    expect(vue).not.toMatch(/[^A] cluster index = \d/);
  }, 30000);

  it('`get system status` d un AUTONOME n a aucune ligne de grappe', async () => {
    const seul = pareFeu('FGT-SEUL', 0);
    const vue = await statut(seul);

    expect(vue).toContain('Current HA mode: standalone');
    expect(vue).not.toContain('Cluster uptime:');
    expect(vue).not.toContain('Cluster state change time:');
  }, 30000);

  it('`get system status` en grappe porte le mode ET le role', async () => {
    const { a } = await grappe();
    expect(await statut(a)).toContain('Current HA mode: a-p, primary');
  }, 30000);

  it('il porte la duree de grappe en toutes lettres', async () => {
    const { a } = await grappe();
    expect(await statut(a))
      .toMatch(/Cluster uptime: \d+ days, \d+ hours, \d+ minutes, \d+ seconds/);
  }, 30000);

  it('et l heure du changement d etat, celle de l EQUIPEMENT', async () => {
    const { a } = await grappe();
    const lu = /Cluster state change time: (\S+) /.exec(await statut(a))?.[1] ?? '';
    const horloge = /current date is: (\S+)/.exec(
      String(await a.executeCommand('execute date')))?.[1] ?? '';

    expect(horloge).not.toBe('');
    expect(lu).toBe(horloge);
  }, 30000);

  it('NON-REGRESSION : les deux vues s accordent sur le role', async () => {
    const { a } = await grappe();

    expect(await ha(a)).toMatch(/^Primary : FGT-A, /m);
    expect(await statut(a)).toContain(', primary');
  }, 30000);
});
