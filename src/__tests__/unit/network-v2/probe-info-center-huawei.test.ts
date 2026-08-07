/**
 * `info-center` — ce qui est refusé, ce que l'aide descend, et surtout
 * ce que la configuration rend (`docs/PRD-Info-Center-Huawei.md`).
 *
 * Le défaut le plus coûteux n'était pas l'acceptation générale mais la
 * CONFIGURATION RENDUE : elle est rejouée à l'import, et
 * `info-center loghost source LoopBack0` en revenait
 * `info-center loghost source channel 2 facility local7` — le mot
 * `source` pris pour un nom d'hôte, donc un collecteur fantôme dans un
 * routeur qu'on croyait avoir sauvegardé.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { InfoCenterConfig } from '@/network/devices/router/management/InfoCenterConfig';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function configure(lignes: string[]): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('AR1');
  await r.executeCommand('system-view');
  for (const l of lignes) await r.executeCommand(l);
  await r.executeCommand('quit');
  return r;
}

async function configLines(r: HuaweiRouter): Promise<string[]> {
  return (await r.executeCommand('display current-configuration'))
    .split('\n').map(l => l.trim()).filter(l => /^(undo )?info-center/.test(l));
}

describe('une commande info-center qui ne veut rien dire est refusée', () => {
  const REFUSES = [
    'info-center nimportequoi',
    'info-center loghost 999.1.1.1',
    'info-center loghost',
    'info-center logbuffer size 99999',
    'info-center trapbuffer size 5000',
    'info-center channel 12 name x',
    'info-center channel 0 name 9mauvais',
    'info-center source NAWAK channel 0 log level warning',
    'info-center source OSPF channel 0 log level nawak',
    'info-center source OSPF channel 99 log level warning',
    'info-center timestamp log nawak',
    'info-center timestamp nawak date',
    'info-center loghost 10.0.0.1 facility nawak',
    'info-center loghost 10.0.0.1 transport sctp',
    'info-center loghost 10.0.0.1 port 0',
    'info-center console channel 12',
  ];

  it.each(REFUSES)('%s', async (cmd) => {
    const r = new HuaweiRouter('AR1');
    await r.executeCommand('system-view');
    expect(await r.executeCommand(cmd)).toMatch(/Error:/);
  });

  it('une valeur refusée ne modifie rien', async () => {
    const r = await configure([
      'info-center logbuffer size 1024',
      'info-center logbuffer size 99999',
    ]);
    expect(await r.executeCommand('display info-center')).toContain('Log buffer size: 1024');
  });

  it('les familles qui supposent une brique absente sont refusées, pas avalées', async () => {
    const r = new HuaweiRouter('AR1');
    await r.executeCommand('system-view');
    // Fichiers de journal et filtrage par alias de module : ni l'un ni
    // l'autre n'existe côté VRP ici.
    for (const c of ['info-center filter-id bymodule-alias OSPF hello',
      'info-center max-logfile-number 10', 'info-center logfile size 4']) {
      expect(await r.executeCommand(c), c).toMatch(/Error:/);
    }
  });

  it('le curseur se pose sous le mot fautif', async () => {
    const r = new HuaweiRouter('AR1');
    await r.executeCommand('system-view');
    const out = await r.executeCommand('info-center loghost 999.1.1.1');
    const [marker] = out.split('\n');
    expect(marker.indexOf('^')).toBe('info-center loghost '.length);
  });
});

describe('un collecteur est identifié par son adresse, pas empilé', () => {
  it('redéclarer la même adresse la MODIFIE', async () => {
    const r = await configure([
      'info-center loghost 10.0.0.1',
      'info-center loghost 10.0.0.1 channel 6 facility local3',
    ]);
    const lignes = (await configLines(r)).filter(l => l.includes('10.0.0.1'));
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toContain('channel 6');
    expect(lignes[0]).toContain('facility local3');
  });

  it('`undo info-center loghost <ip>` le retire', async () => {
    const r = await configure([
      'info-center loghost 10.0.0.1',
      'info-center loghost 10.0.0.2',
      'undo info-center loghost 10.0.0.1',
    ]);
    const lignes = await configLines(r);
    expect(lignes.some(l => l.includes('10.0.0.1'))).toBe(false);
    expect(lignes.some(l => l.includes('10.0.0.2'))).toBe(true);
  });

  it('`loghost source <interface>` est l\'interface source, pas un collecteur', async () => {
    const r = await configure(['info-center loghost source LoopBack0']);
    const lignes = await configLines(r);
    expect(lignes).toContain('info-center loghost source LoopBack0');
    // Le défaut mesuré : `source` devenait un nom d'hôte, et la ligne
    // revenait `info-center loghost source channel 2 facility local7`.
    expect(lignes.some(l => /loghost source channel/.test(l))).toBe(false);
    expect(await r.executeCommand('display info-center'))
      .toContain('Log host source interface: LoopBack0');
    expect(await r.executeCommand('display info-center')).toContain('Configured loghosts: 0');
  });
});

describe('la configuration reproduit ce qui a été tapé', () => {
  it('le port et le transport survivent', async () => {
    const r = await configure(['info-center loghost 10.0.0.9 port 1470 transport tcp']);
    const ligne = (await configLines(r)).find(l => l.includes('10.0.0.9'))!;
    expect(ligne).toContain('port 1470');
    expect(ligne).toContain('transport tcp');
  });

  it('le format d\'horodatage et sa précision survivent', async () => {
    const r = await configure(['info-center timestamp log short-date precision-time millisecond']);
    expect(await configLines(r))
      .toContain('info-center timestamp log short-date precision-time millisecond');
  });

  it('le type d\'enregistrement d\'une source survit', async () => {
    const r = await configure(['info-center source OSPF channel 4 log level warning']);
    const ligne = (await configLines(r)).find(l => l.startsWith('info-center source'))!;
    expect(ligne).toContain(' log ');
    expect(ligne).toContain('level warning');
  });

  it('un canal renommé et une destination réaffectée survivent', async () => {
    const r = await configure([
      'info-center channel 0 name maconsole',
      'info-center console channel 6',
    ]);
    const lignes = await configLines(r);
    expect(lignes).toContain('info-center channel 0 name maconsole');
    expect(lignes).toContain('info-center console channel 6');
  });

  it('ce qui vaut l\'usine n\'est pas rendu', async () => {
    const r = await configure([
      'info-center enable',
      'info-center timestamp log date',
      'info-center logbuffer size 512',
    ]);
    expect(await configLines(r)).toHaveLength(0);
  });

  it('`undo info-center enable` est rendu, lui', async () => {
    const r = await configure(['undo info-center enable']);
    expect(await configLines(r)).toContain('undo info-center enable');
  });
});

describe('ce que l\'aide descend', () => {
  async function aide(q: string): Promise<string> {
    const r = new HuaweiRouter('AR1');
    await r.executeCommand('system-view');
    return r.executeCommand(q);
  }

  it('`info-center ?` propose les sous-commandes réelles, décrites', async () => {
    const out = await aide('info-center ?');
    for (const k of ['channel', 'console', 'enable', 'logbuffer', 'loghost',
      'monitor', 'snmpagent', 'source', 'timestamp', 'trapbuffer']) {
      expect(out, k).toContain(k);
    }
    // Le libellé interne que la boucle générique de bascules imprimait.
    expect(out).not.toContain('Toggle:');
  });

  it('`info-center loghost ?` ne propose plus `enable`', async () => {
    const out = await aide('info-center loghost ?');
    expect(out).toContain('A.B.C.D');
    expect(out).toContain('source');
    expect(out).not.toContain('Toggle:');
  });

  it('les sévérités portent leur numéro, comme du côté IOS', async () => {
    const out = await aide('info-center source OSPF channel 4 log level ?');
    expect(out).toMatch(/emergencies\s+Emergency error \(severity=0\)/);
    expect(out).toMatch(/warning\s+Warning \(severity=4\)/);
    expect(out).toMatch(/debugging\s+Debug information \(severity=7\)/);
  });

  it('la complétion marche sur les sous-commandes', async () => {
    expect(await aide('info-center log?')).toContain('logbuffer');
    expect(await aide('info-center log?')).toContain('loghost');
  });
});

describe('les vues lisent l\'état réel', () => {
  it('`display channel` rend les DIX canaux d\'usine', async () => {
    const r = await configure([]);
    const out = await r.executeCommand('display channel');
    for (const nom of ['console', 'monitor', 'loghost', 'trapbuffer',
      'logbuffer', 'snmpagent', 'channel6', 'channel9']) {
      expect(out, nom).toContain(nom);
    }
    // La phrase en dur d'avant, sur une machine qui en a dix.
    expect(out).not.toContain('No info-center channels configured');
  });

  it('`display channel <n>` ne rend que celui-là, avec ses abonnés', async () => {
    const r = await configure(['info-center source OSPF channel 4 log level warning']);
    const out = await r.executeCommand('display channel 4');
    expect(out).toContain('channel number:4, channel name:logbuffer');
    expect(out).toContain('dest: logbuffer');
    expect(out).toContain('OSPF');
    expect(out).not.toContain('channel number:0');
  });

  it('un canal renommé est retrouvé par son NOM', async () => {
    const r = await configure(['info-center channel 4 name montampon']);
    expect(await r.executeCommand('display channel montampon'))
      .toContain('channel number:4, channel name:montampon');
  });

  it('`display channel <inconnu>` est refusé', async () => {
    const r = await configure([]);
    expect(await r.executeCommand('display channel 42')).toMatch(/Error:/);
  });

  it('`display logbuffer` annonce la taille configurée, pas celle d\'IOS', async () => {
    const r = await configure(['info-center logbuffer size 1024']);
    const out = await r.executeCommand('display logbuffer');
    expect(out).toContain('Allowed max buffer size : 1024');
    expect(out).toContain('Actual buffer size : 1024');
  });

  it('`display logbuffer` annonce le canal réellement affecté', async () => {
    const r = await configure(['info-center logbuffer channel 6']);
    expect(await r.executeCommand('display logbuffer'))
      .toContain('Channel number : 6 , Channel name : channel6');
  });

  it('`display trapbuffer` annonce lui aussi la taille configurée', async () => {
    const r = await configure(['info-center trapbuffer size 512']);
    expect(await r.executeCommand('display trapbuffer'))
      .toContain('Allowed max buffer size : 512');
  });

  it('`display info-center` compte ce qui existe', async () => {
    const r = await configure([
      'info-center loghost 10.0.0.1',
      'info-center loghost 10.0.0.2',
      'info-center loghost source LoopBack0',
    ]);
    const out = await r.executeCommand('display info-center');
    expect(out).toContain('Configured loghosts: 2');
    expect(out).toContain('Log host: 10.0.0.1, 10.0.0.2');
  });
});

describe('l\'analyseur, sans la coquille', () => {
  it('un abrégé non ambigu vaut le mot entier', () => {
    const c = new InfoCenterConfig();
    expect(c.apply(['source', 'OSPF', 'channel', '4', 'log', 'level', 'warn'], false)).toBeNull();
    expect(c.sources[0].severity).toBe('warning');
  });

  it('un abrégé ambigu est refusé', () => {
    const c = new InfoCenterConfig();
    // `e` désigne `emergencies` comme `error`.
    expect(c.apply(['source', 'OSPF', 'channel', '4', 'log', 'level', 'e'], false))
      .not.toBeNull();
  });

  it('un canal se désigne par son numéro ou par son nom', () => {
    const c = new InfoCenterConfig();
    expect(c.resolveChannel('4')).toBe(4);
    expect(c.resolveChannel('logbuffer')).toBe(4);
    expect(c.resolveChannel('10')).toBeNull();
    expect(c.resolveChannel('inconnu')).toBeNull();
  });

  it('une précision d\'horodatage n\'a pas de sens derrière `boot` ni `none`', () => {
    const c = new InfoCenterConfig();
    expect(c.apply(['timestamp', 'log', 'boot', 'precision-time', 'millisecond'], false))
      .not.toBeNull();
    expect(c.apply(['timestamp', 'log', 'none', 'precision-time', 'second'], false))
      .not.toBeNull();
    expect(c.apply(['timestamp', 'log', 'date', 'precision-time', 'second'], false))
      .toBeNull();
  });

  it('réaffecter une destination puis l\'annuler la remet d\'usine', () => {
    const c = new InfoCenterConfig();
    c.apply(['console', 'channel', '6'], false);
    expect(c.destinationChannel.console).toBe(6);
    c.apply(['console', 'channel'], true);
    expect(c.destinationChannel.console).toBe(0);
  });
});
