/**
 * Probes — `sl`, `cl /bu:` et `al` (PRD-Wevtutil.md phase 4).
 *
 * Les verbes qui écrivent. La question qui gouverne ces probes est
 * toujours la même : le réglage a-t-il un effet observable, ou n'est-il
 * que rangé quelque part ? Un journal désactivé doit cesser d'accepter
 * des entrées, sinon `/e:false` ne vaut rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const field = (out: string, name: string): string =>
  out.split('\n').find((l) => l.trim().startsWith(`${name}:`))?.split(':').slice(1).join(':').trim() ?? '';

const records = async (dc: WindowsServer, log: string): Promise<number> =>
  Number(field(String(await dc.executeCmdCommand(`wevtutil gli ${log}`)), 'numberOfLogRecords'));

describe('Scénario 1 — `sl` change réellement quelque chose', () => {
  it('un journal désactivé cesse d\'accepter des entrées', async () => {
    const dc = new WindowsServer('DC01');
    const before = await records(dc, 'Security');

    expect(await dc.executeCmdCommand('wevtutil sl Security /e:false')).toBe('');
    dc.getProcessManager().spawnProcess('notepad.exe', 100, 'DC01\\Administrator', {});

    expect(
      await records(dc, 'Security'),
      'un réglage qui n\'empêche rien n\'est pas un réglage',
    ).toBe(before);
  });

  it('et le réactiver le remet en service', async () => {
    const dc = new WindowsServer('DC01');
    await dc.executeCmdCommand('wevtutil sl Security /e:false');
    await dc.executeCmdCommand('wevtutil sl Security /e:true');
    const before = await records(dc, 'Security');

    dc.getProcessManager().spawnProcess('notepad.exe', 100, 'DC01\\Administrator', {});
    expect(await records(dc, 'Security')).toBeGreaterThan(before);
  });

  it('`gl` reflète l\'état posé', async () => {
    const dc = new WindowsServer('DC01');
    await dc.executeCmdCommand('wevtutil sl Application /e:false');
    expect(field(String(await dc.executeCmdCommand('wevtutil gl Application')), 'enabled'))
      .toBe('false');
  });

  it('`/ms:` se donne en octets et se relit en octets', async () => {
    const dc = new WindowsServer('DC01');
    await dc.executeCmdCommand('wevtutil sl Application /ms:1048576');
    expect(field(String(await dc.executeCmdCommand('wevtutil gl Application')), 'maxSize'))
      .toBe('1048576');
  });

  it('une taille invalide est refusée', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil sl Application /ms:abc'))
      .toContain('is not a valid size');
  });

  it('`/r:` sur `sl` est la rétention, pas une machine distante', async () => {
    const dc = new WindowsServer('DC01');
    // La même lettre désigne deux choses selon le verbe. `sl /r:` doit
    // donc être acceptée là où `qe /r:` est refusée.
    expect(await dc.executeCmdCommand('wevtutil sl Application /r:true')).toBe('');
    expect(field(String(await dc.executeCmdCommand('wevtutil gl Application')), 'retention'))
      .toBe('true');
    expect(await dc.executeCmdCommand('wevtutil qe Application /r:AUTRE'))
      .toContain('is not recognized');
  });

  it('un journal inconnu est refusé', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil sl Fantome /e:false'))
      .toContain('The specified channel could not be found');
  });
});

describe('Scénario 2 — `cl /bu:` rend l\'effacement réversible', () => {
  it('la sauvegarde contient ce que le journal contenait', async () => {
    const dc = new WindowsServer('DC01');
    const before = String(await dc.executeCmdCommand('wevtutil qe Security /f:text'));
    expect(before).toContain('Event ID:');

    expect(await dc.executeCmdCommand('wevtutil cl Security /bu:C:\\Bak\\Sec.evtx')).toBe('');
    expect(await records(dc, 'Security')).toBe(0);

    const restored = String(await dc.executeCmdCommand(
      'wevtutil qe C:\\Bak\\Sec.evtx /lf:true /f:text'));
    expect(
      [...restored.matchAll(/Event ID:\s*(\d+)/g)].map((m) => m[1]),
      'une sauvegarde qui ne se relit pas ne sauvegarde rien',
    ).toEqual([...before.matchAll(/Event ID:\s*(\d+)/g)].map((m) => m[1]));
  });

  it('sans `/bu:`, l\'effacement reste sans filet', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil cl Application')).toBe('');
    expect(await records(dc, 'Application')).toBe(0);
  });
});

describe('Scénario 3 — `al`', () => {
  it('archive un fichier exporté', async () => {
    const dc = new WindowsServer('DC01');
    await dc.executeCmdCommand('wevtutil epl System C:\\Exp\\Sys.evtx');
    expect(await dc.executeCmdCommand('wevtutil al C:\\Exp\\Sys.evtx')).toBe('');
  });

  it('et refuse un fichier absent', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil al C:\\Exp\\Rien.evtx'))
      .toContain('cannot find the file');
  });
});
