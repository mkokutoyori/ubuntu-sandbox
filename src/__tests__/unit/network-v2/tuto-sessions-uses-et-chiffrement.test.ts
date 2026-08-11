/**
 * Les deux derniers points ouverts de `PRD-Sessions-Cisco.md`.
 *
 * 1. **`Uses` valait 0 pour toujours, sur toutes les lignes.** La
 *    colonne etait rendue sans qu'aucun compteur vive derriere. C'est
 *    pourtant le chiffre qui distingue une ligne QU'ON N'A JAMAIS
 *    UTILISEE d'une ligne simplement libre en ce moment — la question
 *    que ce tableau sert a poser, et celle par laquelle commence le
 *    diagnostic du scenario 1 du tutoriel.
 *
 *    Le compte est CUMULATIF : il ne redescend pas quand la session se
 *    ferme. « Combien de connexions depuis le dernier demarrage » n'est
 *    pas « combien maintenant », que la table des sessions dit deja.
 *
 *    La cle porte le TYPE en plus du rang (`con:0`, `vty:0`) parce que
 *    `con 0` et `vty 0` valent tous deux zero dans leur propre
 *    numerotation : une cle numerique seule les aurait confondus et la
 *    console aurait compte pour la premiere vty.
 *
 * 2. **`show ssh` decrivait un chiffrement ECRIT EN DUR.** Une machine
 *    sur laquelle on venait de taper
 *    `ip ssh server algorithm encryption aes128-ctr` annoncait quand
 *    meme `aes256-ctr` — elle contredisait sa propre configuration au
 *    meme instant. La valeur vient desormais de la machine.
 *
 *    **Ce que cela ne fait PAS**, et qui reste ecrit : ce simulateur ne
 *    NEGOCIE pas ces algorithmes. Ce qui est rendu est la preference du
 *    serveur — le premier de la liste qu'il accepte — c'est-a-dire ce
 *    qu'un vrai serveur retient quand le client offre tout. Il n'y a
 *    pas d'intersection a calculer parce qu'aucun client n'offre rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoTerminalSession } from '@/terminal/sessions';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Registre {
  open(i: Record<string, unknown>): { id: string } | null;
  close(id: string, reason?: string): void;
  usesFor(k: 'con' | 'vty' | 'aux', i: number): number;
}
const registre = (d: CiscoRouter): Registre =>
  (d as unknown as { getSshSessionRegistry(): Registre }).getSshSessionRegistry();

async function routeur(...cfg: string[]): Promise<CiscoRouter> {
  const d = new CiscoRouter('R1', 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  if (cfg.length > 0) {
    await d.executeCommand('configure terminal');
    for (const c of cfg) await d.executeCommand(c);
    await d.executeCommand('end');
  }
  return d;
}

/** La colonne `Uses` de la ligne dont le libelle est donne. */
function usesDansLeTableau(sortie: string, tty: number): number {
  const ligne = sortie.split('\n').find((l) => new RegExp(`^[* ]\\s*${tty}\\s+(CTY|AUX|VTY)`).test(l));
  if (!ligne) throw new Error(`ligne tty ${tty} absente de:\n${sortie}`);
  // Colonnes : … AccI  Uses  Noise  Overruns  Int
  const champs = ligne.trim().split(/\s+/);
  return Number.parseInt(champs[champs.length - 4], 10);
}

// ── 1. `Uses` ───────────────────────────────────────────────────────

describe('`Uses` compte vraiment les connexions par ligne', () => {
  it('tout est a zero sur une machine qui vient de demarrer', async () => {
    const d = await routeur();
    const out = await d.executeCommand('show line');
    for (const tty of [0, 1, 2, 3, 4]) expect(usesDansLeTableau(out, tty)).toBe(0);
  }, 30_000);

  it('une session vty incremente SA ligne, et elle seule', async () => {
    const d = await routeur();
    registre(d).open({ user: 'jb', fromIp: '192.168.1.55', localPort: 22, peerPort: 1 });
    const out = await d.executeCommand('show line');
    expect(usesDansLeTableau(out, 2), 'vty 0 = tty 2').toBe(1);
    expect(usesDansLeTableau(out, 3), 'vty 1 intacte').toBe(0);
    expect(usesDansLeTableau(out, 0), 'la console intacte').toBe(0);
  }, 30_000);

  /**
   * Le compte ne redescend PAS a la fermeture : `Uses` dit « depuis le
   * demarrage », pas « en ce moment ». Sans ce cas, un compteur remis a
   * zero passerait pour correct tant qu'on ne ferme rien.
   */
  it('le compte survit a la fermeture — il est cumulatif', async () => {
    const d = await routeur();
    const s = registre(d).open({ user: 'jb', fromIp: '10.0.0.1', localPort: 22, peerPort: 1 });
    registre(d).close(s!.id, 'exit');
    expect(usesDansLeTableau(await d.executeCommand('show line'), 2)).toBe(1);
    registre(d).open({ user: 'mc', fromIp: '10.0.0.2', localPort: 22, peerPort: 2 });
    expect(usesDansLeTableau(await d.executeCommand('show line'), 2)).toBe(2);
  }, 30_000);

  it('ouvrir une console compte pour `con 0`', async () => {
    const d = await routeur();
    for (let i = 0; i < 2; i++) {
      const s = new CiscoTerminalSession(`t${i}`, d as never);
      await s.init();
      for (let k = 0; k < 40 && s.isBooting; k++) await tick();
    }
    expect(usesDansLeTableau(await d.executeCommand('show line'), 0)).toBe(2);
  }, 30_000);

  /**
   * Le temoin qui prouve que la cle porte le type : `con 0` et `vty 0`
   * valent tous deux zero dans leur propre numerotation. Une cle
   * numerique seule les aurait confondus.
   */
  it('la console et vty 0 comptent SEPAREMENT', async () => {
    const d = await routeur();
    const s = new CiscoTerminalSession('t1', d as never);
    await s.init();
    for (let k = 0; k < 40 && s.isBooting; k++) await tick();
    const out = await d.executeCommand('show line');
    expect(usesDansLeTableau(out, 0), 'console').toBe(1);
    expect(usesDansLeTableau(out, 2), 'vty 0 ne doit pas avoir bouge').toBe(0);
  }, 30_000);

  it('le bloc de detail rend la meme ligne de resume', async () => {
    const d = await routeur();
    registre(d).open({ user: 'jb', fromIp: '10.0.0.1', localPort: 22, peerPort: 1 });
    expect(usesDansLeTableau(await d.executeCommand('show line vty 0'), 2)).toBe(1);
  }, 30_000);
});

// ── 2. `show ssh` : le chiffrement vient de la machine ───────────────

describe('`show ssh` decrit les algorithmes CONFIGURES', () => {
  async function avecSession(...cfg: string[]): Promise<CiscoRouter> {
    const d = await routeur(...cfg);
    registre(d).open({ user: 'jean-baptiste', fromIp: '192.168.1.55', localPort: 22, peerPort: 52341 });
    return d;
  }

  it('sans restriction, le defaut de la plateforme', async () => {
    const out = await (await avecSession()).executeCommand('show ssh');
    expect(out).toContain('aes256-ctr');
    expect(out).toContain('hmac-sha2-256');
  }, 30_000);

  it('`ip ssh server algorithm encryption` change ce qui est annonce', async () => {
    const d = await avecSession('ip ssh server algorithm encryption aes128-ctr');
    const out = await d.executeCommand('show ssh');
    expect(out).toContain('aes128-ctr');
    expect(out).not.toContain('aes256-ctr');
  }, 30_000);

  it('`ip ssh server algorithm mac` de meme', async () => {
    const d = await avecSession('ip ssh server algorithm mac hmac-sha1');
    const out = await d.executeCommand('show ssh');
    expect(out).toContain('hmac-sha1');
    expect(out).not.toContain('hmac-sha2-256');
  }, 30_000);

  /**
   * C'est la PREFERENCE du serveur qui est rendue — le premier de la
   * liste — donc une liste de plusieurs algorithmes ne rend que le
   * premier, comme un vrai serveur retiendrait le sien face a un client
   * qui offre tout.
   */
  it('avec plusieurs algorithmes, le PREMIER est retenu', async () => {
    const d = await avecSession('ip ssh server algorithm encryption aes192-ctr aes128-ctr');
    expect(await d.executeCommand('show ssh')).toContain('aes192-ctr');
  }, 30_000);

  it('`show ip ssh` et `show ssh` decrivent la meme machine', async () => {
    const d = await avecSession('ip ssh server algorithm encryption aes128-ctr');
    expect(await d.executeCommand('show ip ssh')).toContain('aes128-ctr');
    expect(await d.executeCommand('show ssh')).toContain('aes128-ctr');
  }, 30_000);

  it('le commutateur repond toujours dans les memes mots que le routeur', async () => {
    const sw = new CiscoSwitch('SW1');
    sw.powerOn();
    await sw.executeCommand('enable');
    const d = await routeur();
    expect(await sw.executeCommand('show ssh')).toBe(await d.executeCommand('show ssh'));
  }, 30_000);
});
