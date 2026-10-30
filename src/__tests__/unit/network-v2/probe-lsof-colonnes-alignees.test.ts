/**
 * `lsof` : chaque colonne a la largeur de son contenu, comme dans le vrai.
 *
 * Mesuré avant le correctif : l'en-tête était une chaîne littérale
 * (`COMMAND     PID   USER   FD    TYPE DEVICE SIZE/OFF NODE NAME`) et les
 * lignes d'AUTRES chaînes aux `padToWidth` comptés à part (6 pour USER, 5
 * pour PID, 5 pour le numéro d'inode…). Rien ne les reliait, donc dès qu'un
 * utilisateur dépassait six caractères (`www-data`, huit) ou qu'un PID
 * dépassait cinq chiffres, les lignes glissaient sous un en-tête qui ne
 * bougeait pas. C'est le défaut que `cli/TextTable.ts` décrit en tête de
 * fichier (« l'en-tête d'un tableau est une CHAÎNE LITTÉRALE et ses lignes de
 * données une AUTRE chaîne ») ; `lsof` en était un exemple de plus.
 *
 * Autorité : lsof-org/lsof (cloné), `src/print.c` : `print_init` mesure
 * chaque colonne sur son TITRE puis la première passe l'élargit à la plus
 * large valeur ; l'en-tête s'imprime en seconde passe avec les mêmes
 * largeurs (`CmdColW`, `PidColW`, `UserColW`, `FdColW`, `TypeColW`,
 * `DevColW`, `SzOffColW`, `NodeColW`). COMMAND est à gauche et plafonné à 9
 * caractères (`CMDL`) ; PID, USER, TYPE, DEVICE, SIZE/OFF et NODE sont à
 * DROITE (`%*s`) ; FD est le descripteur aligné à droite dans `FdColW - 2`
 * suivi du mode d'accès et du verrou ; NAME est la dernière colonne, sans
 * calage.
 *
 * Discrimination par `git stash` de src/network : voir le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function serveur(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'Server1');
  srv.powerOn();
  await srv.executeCommand('systemctl start nginx');
  return srv;
}

interface Columns {
  readonly end: Record<'PID' | 'USER' | 'TYPE' | 'DEVICE' | 'SIZE/OFF' | 'NODE', number>;
  readonly nameStart: number;
}

function headerColumns(header: string): Columns {
  const endOf = (title: string): number => header.indexOf(title) + title.length;
  return {
    end: {
      PID: endOf('PID'), USER: endOf('USER'), TYPE: endOf('TYPE'),
      DEVICE: endOf('DEVICE'), 'SIZE/OFF': endOf('SIZE/OFF'), NODE: endOf('NODE'),
    },
    nameStart: header.indexOf('NAME'),
  };
}

function tokenEnds(line: string): number[] {
  const ends: number[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null && ends.length < 8) ends.push(match.index + match[0].length);
  return ends;
}

describe('lsof sur une machine qui sert du web', () => {
  it('l\'en-tête porte les neuf titres de lsof', async () => {
    const out = (await (await serveur()).executeCommand('lsof')).split('\n');
    expect(out[0].split(/\s+/)).toEqual(['COMMAND', 'PID', 'USER', 'FD', 'TYPE', 'DEVICE', 'SIZE/OFF', 'NODE', 'NAME']);
  });

  it('PID, USER, TYPE, DEVICE, SIZE/OFF et NODE finissent sous leur titre, ligne après ligne', async () => {
    const lines = (await (await serveur()).executeCommand('lsof')).split('\n');
    const columns = headerColumns(lines[0]);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines.slice(1)) {
      const ends = tokenEnds(line);
      expect(ends[1], `PID  « ${line} »`).toBe(columns.end.PID);
      expect(ends[2], `USER « ${line} »`).toBe(columns.end.USER);
      expect(ends[4], `TYPE « ${line} »`).toBe(columns.end.TYPE);
      expect(ends[5], `DEVICE « ${line} »`).toBe(columns.end.DEVICE);
      expect(ends[6], `SIZE/OFF « ${line} »`).toBe(columns.end['SIZE/OFF']);
      expect(ends[7], `NODE « ${line} »`).toBe(columns.end.NODE);
    }
  });

  it('NAME commence au même caractère sur toutes les lignes', async () => {
    const lines = (await (await serveur()).executeCommand('lsof')).split('\n');
    const nameStart = lines[0].indexOf('NAME');
    for (const line of lines.slice(1)) {
      expect(line.slice(nameStart - 1, nameStart), `« ${line} »`).toBe(' ');
      expect(line[nameStart], `« ${line} »`).not.toBe(' ');
    }
  });

  it('www-data (huit caractères) élargit USER, qui reste aligné à droite', async () => {
    const out = await (await serveur()).executeCommand('lsof');
    expect(out).toContain('www-data');
    const lines = out.split('\n');
    const userEnd = headerColumns(lines[0]).end.USER;
    const wide = lines.find((l) => l.includes('www-data'));
    expect(wide).toBeDefined();
    expect(wide!.indexOf('www-data') + 'www-data'.length).toBe(userEnd);
    expect(lines[0].indexOf('USER')).toBe(userEnd - 4);
  });

  it('COMMAND est calé à gauche et plafonné à neuf caractères', async () => {
    const lines = (await (await serveur()).executeCommand('lsof')).split('\n');
    for (const line of lines.slice(1)) {
      const command = line.split(/\s+/)[0];
      expect(command.length, `« ${line} »`).toBeLessThanOrEqual(9);
      expect(line.startsWith(command)).toBe(true);
    }
  });

  it('la ligne d\'une écoute montre IPv4, 0t0, TCP et le nom (LISTEN) comme lsof', async () => {
    const out = await (await serveur()).executeCommand('lsof -i :80');
    const rows = out.split('\n').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatch(/IPv4\s+\d+\s+0t0\s+TCP \*:80 \(LISTEN\)$/);
  });

  it('WITNESS : -p d\'un processus absent garde le message de lsof', async () => {
    const out = await (await serveur()).executeCommand('lsof -p 999999');
    expect(out).toBe('lsof: PID 999999: No such process');
  });
});
