/**
 * PRD-CLI-Fidelite-VRP.md §1.8 / chantier D §3 et §5 / lot V5 — les
 * bornes qu'on connaît, et l'abreviation du nom d'interface.
 *
 * Deux proprietes :
 *
 * 1. Une borne CONNUE se verifie — et seulement une borne connue. Ce
 *    lot n'invente pas celles dont je ne suis pas sur, et un test fixe
 *    ce qui reste ouvert.
 * 2. L'abreviation d'un nom d'interface est une REGLE (tout prefixe non
 *    ambigu du type), pas une liste d'ecritures admises. Le balayage
 *    parcourt donc les prefixes, y compris ceux que personne n'avait
 *    pense a inscrire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
interface Cli { executeCommand(c: string): Promise<string>; getPrompt(): string }

async function enSysteme(fabrique: () => Cli): Promise<Cli> {
  const d = fabrique();
  await d.executeCommand('system-view');
  return d;
}

const R = () => new HuaweiRouter(`BA${++serie}`) as unknown as Cli;
const S = () => new HuaweiSwitch(`BB${++serie}`) as unknown as Cli;

const REFUS = /^Error: (Wrong parameter|Incomplete command|Unrecognized command|Too many parameters) found at '\^' position\./;

describe('une borne connue se verifie', () => {
  it('un router-id EST une adresse IPv4', async () => {
    for (const mauvais of ['999.999.999.999', 'pasuneadresse', '1.1.1', '1.1.1.256', '']) {
      const r = await enSysteme(R);
      const out = await r.executeCommand(`ospf 1 router-id ${mauvais}`.trim());
      expect(out, mauvais).toMatch(REFUS);
    }
  });

  it('et une adresse valide passe, et prend', async () => {
    const r = await enSysteme(R);
    expect(await r.executeCommand('ospf 1 router-id 9.9.9.9')).toBe('');
    await r.executeCommand('quit');
    expect(await r.executeCommand('display current-configuration')).toContain('router-id 9.9.9.9');
  });

  it('la preference d\'une route statique va de 1 a 255', async () => {
    for (const [valeur, attendu] of [
      ['0', 'refuse'], ['256', 'refuse'], ['-1', 'refuse'], ['abc', 'refuse'],
      ['1', 'passe'], ['100', 'passe'], ['255', 'passe'],
    ] as const) {
      const r = await enSysteme(R);
      const out = await r.executeCommand(
        `ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 preference ${valeur}`);
      if (attendu === 'refuse') expect(out, valeur).toMatch(REFUS);
      else expect(out, valeur).toBe('');
    }
  });

  it('un refus de borne ne pose rien', async () => {
    const r = await enSysteme(R);
    await r.executeCommand('ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 preference 0');
    expect(await r.executeCommand('display current-configuration')).not.toContain('10.0.0.0');
  });
});

describe('l\'abreviation du nom d\'interface est une regle', () => {
  /** Tous les prefixes non ambigus de `GigabitEthernet`, du plus court. */
  const PREFIXES_GE = ['g', 'gi', 'gig', 'giga', 'gigabitethernet'];

  it('routeur : tout prefixe non ambigu mene a la meme interface', async () => {
    for (const p of [...PREFIXES_GE, 'ge']) {
      const r = await enSysteme(R);
      expect(await r.executeCommand(`interface ${p}0/0/0`), p).toBe('');
      expect(r.getPrompt(), p).toContain('GigabitEthernet0/0/0');
    }
  });

  it('switch : la meme regle, sur ses propres types', async () => {
    for (const [p, attendu] of [
      ['g0/0/1', 'GigabitEthernet0/0/1'], ['gi0/0/1', 'GigabitEthernet0/0/1'],
      ['v1', 'Vlanif1'], ['vlanif1', 'Vlanif1'],
      ['loop0', 'LoopBack0'], ['l0', 'LoopBack0'],
    ] as const) {
      const s = await enSysteme(S);
      expect(await s.executeCommand(`interface ${p}`), p).toBe('');
      expect(s.getPrompt(), p).toContain(attendu);
    }
  });

  it('une interface virtuelle se cree par son abreviation aussi', async () => {
    for (const p of ['loop7', 'l7', 'LoopBack7']) {
      const r = await enSysteme(R);
      expect(await r.executeCommand(`interface ${p}`), p).toBe('');
      expect(r.getPrompt(), p).toContain('LoopBack7');
    }
  });

  it('un type inconnu reste refuse', async () => {
    for (const p of ['zzz0/0/0', 'q0', 'xyzzy1']) {
      const r = await enSysteme(R);
      expect(await r.executeCommand(`interface ${p}`), p).toMatch(REFUS);
    }
  });

  it('la casse n\'entre pas en jeu', async () => {
    for (const p of ['G0/0/0', 'gIgAbItEtHeRnEt0/0/0', 'LOOP3']) {
      const r = await enSysteme(R);
      expect(await r.executeCommand(`interface ${p}`), p).toBe('');
    }
  });
});

describe('ce que ce lot n\'invente pas, et le dit', () => {
  it('les bornes que je n\'ai pas pu confirmer restent ouvertes', async () => {
    // La plage des LoopBack et la longueur maximale d'un `sysname`
    // existent sur un vrai VRP, mais je n'en connais pas la valeur
    // exacte. §0 interdit de la deviner : ces deux cas restent acceptes
    // et sont fixes ici pour que la borne, le jour ou une source la
    // donne, soit posee sciemment.
    //
    // Chacune sur sa machine : la premiere descend en vue d'interface,
    // ou `sysname` n'existe pas — et le refus n'aurait alors rien dit
    // de la borne.
    expect(await (await enSysteme(R)).executeCommand('interface LoopBack 1024')).not.toMatch(REFUS);
    expect(await (await enSysteme(R)).executeCommand(`sysname ${'x'.repeat(300)}`)).not.toMatch(REFUS);
  });
});
