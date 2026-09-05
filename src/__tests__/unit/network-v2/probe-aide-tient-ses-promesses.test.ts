/**
 * Un mot-cle offert par `?` ne repond pas « commande inconnue ».
 *
 * Defaut mesure (audit completion, M5) : l'aide proposait des mots que
 * l'analyseur refuse ensuite. C'est la forme la plus couteuse d'aide
 * fausse — elle fait perdre du temps a celui qui lui fait confiance, et
 * elle apprend une syntaxe qui n'existe pas.
 *
 * L'INVARIANT n'est pas « la commande doit s'executer » mais « elle ne
 * doit pas etre INCONNUE ». La distinction est celle qu'IOS fait
 * lui-meme :
 *
 *   % Incomplete command.  → le mot-cle est bon, il en manque d'autres.
 *                            L'aide avait raison de le proposer.
 *   % Invalid input        → ce mot-la n'existe pas ici. L'aide a menti.
 *
 * Le balayage attrape donc DEUX familles de fautes, et c'est voulu :
 * l'aide qui propose un mot-cle inexistant, et l'analyseur qui repond
 * « inconnu » a un mot-cle qu'il connait mais trouve incomplet. Les deux
 * mentent a l'operateur, chacun a sa maniere.
 *
 * Une machine neuve par essai : la commande essayee peut modifier la
 * configuration, et un balayage qui s'observe lui-meme ne mesure plus
 * rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

type Dev = { cliHelp(s: string): string; executeCommand(c: string): Promise<string>; dispose(): void };

const MOT = /^\s\s(\S+)\s\s/;
const offerts = (t: string): string[] =>
  t.includes('Invalid input') ? []
    : t.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((x): x is string => !!x && x !== '<cr>');

/**
 * Un substitut d'argument (`WORD`, `A.B.C.D`, `<1-9>`) n'est pas un
 * mot-cle : on ne peut pas le taper tel quel, donc l'essayer ne mesure
 * rien. Les bornes comptent a l'INTERIEUR du mot et pas seulement en
 * tete — `X:X:X:X::X/<0-128>` est un substitut, et le premier jet le
 * prenait pour un mot-cle faute de cette nuance.
 */
const estSubstitut = (k: string): boolean =>
  k.startsWith('<') || /^[A-Z0-9.:$/<>-]+$/.test(k)
  || (k.includes(':') && !k.endsWith(':'));

let serie = 0;
async function neuf(prelude: readonly string[]): Promise<Dev> {
  const r = new CiscoRouter(`P${serie++}`) as unknown as Dev;
  await r.executeCommand('enable');
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

async function promessesNonTenues(
  prelude: readonly string[], racine: string, profondeur = 3,
): Promise<string[]> {
  const guide = await neuf(prelude);
  const fautes: string[] = [];
  const relacherGuide = (): void => guide.dispose();
  const vus = new Set<string>();
  let file = [racine];
  for (let p = 0; p < profondeur; p++) {
    const suivant: string[] = [];
    for (const base of file) {
      for (const k of offerts(guide.cliHelp(base === '' ? '' : `${base} `))) {
        if (estSubstitut(k)) continue;
        const chemin = base === '' ? k : `${base} ${k}`;
        if (vus.has(chemin)) continue;
        vus.add(chemin);
        if (suivant.length < 240) suivant.push(chemin);
        const essai = await neuf(prelude);
        const out = String(await essai.executeCommand(chemin));
        essai.dispose();
        if (out.includes('Invalid input')) {
          fautes.push(`«${base === '' ? '' : base + ' '}?» offre «${k}»`);
        }
      }
    }
    file = suivant;
  }
  relacherGuide();
  return fautes;
}

/**
 * Le CLIQUET.
 *
 * Le balayage a trouve SOIXANTE-DIX promesses non tenues. Elles sont
 * toutes corrigees : quatre regles structurelles en ont emporte la
 * plupart, et les dernieres etaient des commandes prises une a une —
 * une commande annoncee et jamais ecrite (`write terminal`, `debug
 * dhcp`, `no line`, `no debug domain`), une negation qui manquait, une
 * arite jamais declaree, un rang d'argument decrit une place trop loin
 * (`enable algorithm-type`).
 *
 * La liste est donc VIDE, et l'egalite exacte la maintient : une
 * nouvelle promesse non tenue fait echouer ce fichier en la nommant.
 * On ne peut plus qu'y ajouter une regression, jamais l'ignorer.
 */
const RESTE_CONNU = {
  exec: [] as readonly string[],
  config: [] as readonly string[],
  configIf: [] as readonly string[],
} as const;

describe('M5 — ce que `?` propose, la machine le connait', () => {
  it('en EXEC privilegie, branche `show`', async () => {
    const f = await promessesNonTenues([], 'show');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.exec].sort());
  }, 300_000);

  it('en configuration globale', async () => {
    const f = await promessesNonTenues(['configure terminal'], '');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.config].sort());
  }, 420_000);

  it('en configuration d interface', async () => {
    const f = await promessesNonTenues(
      ['configure terminal', 'interface GigabitEthernet0/0'], '');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.configIf].sort());
  }, 300_000);
});

describe('les cas nommes de l audit', () => {
  it('`ip address A M ?` n offre plus `dhcp`', async () => {
    const r = await neuf(['configure terminal', 'interface GigabitEthernet0/0']);
    expect(offerts(r.cliHelp('ip address 10.0.0.1 255.255.255.0 '))).not.toContain('dhcp');
  });

  it('mais `ip address ?` l offre toujours, ou il a un sens', async () => {
    const r = await neuf(['configure terminal', 'interface GigabitEthernet0/0']);
    expect(offerts(r.cliHelp('ip address '))).toContain('dhcp');
    expect(String(await r.executeCommand('ip address dhcp'))).not.toContain('Invalid input');
  });

  it('`access-list 10 ?` n offre plus `eq`', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('access-list 10 '))).not.toContain('eq');
  });

  it('et offre toujours `deny` et `permit`', async () => {
    const r = await neuf(['configure terminal']);
    const o = offerts(r.cliHelp('access-list 10 '));
    expect(o).toContain('deny');
    expect(o).toContain('permit');
  });

  it('`show interfaces stats ?` n offre plus la plupart de ses freres', async () => {
    const r = await neuf([]);
    const o = offerts(r.cliHelp('show interfaces stats '));
    for (const frere of ['description', 'rate-limit', 'summary']) {
      expect(o, frere).not.toContain(frere);
    }
  });

  it.each([
    ['write terminal', [], 'Current configuration'],
    ['debug dhcp', [], 'debugging is on'],
    ['undebug domain', [], 'debugging is off'],
  ] as Array<[string, string[], string]>)(
    '`%s` etait offerte et refusee ; elle fait maintenant ce qu elle annonce',
    async (cmd, pre, attendu) => {
      const r = await neuf(pre);
      expect(String(await r.executeCommand(cmd)), cmd).toContain(attendu);
    });

  it('`no line vty 0 4` retire le bloc, et la configuration cesse de le rendre', async () => {
    const r = await neuf(['configure terminal']);
    await r.executeCommand('line vty 0 4');
    await r.executeCommand('exec-timeout 9 0');
    await r.executeCommand('exit');
    expect(String(await r.executeCommand('do show running-config'))).toContain('line vty 0 4');
    expect(String(await r.executeCommand('no line vty 0 4'))).not.toContain('Invalid');
    expect(String(await r.executeCommand('do show running-config'))).not.toContain('exec-timeout 9 0');
  });

  it('mais la console ne se retire pas d un chassis', async () => {
    const r = await neuf(['configure terminal']);
    expect(String(await r.executeCommand('no line console 0'))).toContain("Can't delete");
  });

  it('un mot ABSENT est reclame, un mot FAUX est nie', async () => {
    const r = await neuf([]);
    expect(String(await r.executeCommand('debug aaa'))).toContain('Incomplete');
    expect(String(await r.executeCommand('debug aaa zzz'))).toContain('Invalid input');
  });

  it('`enable algorithm-type ?` nomme l algorithme, pas le rang suivant', async () => {
    const r = await neuf(['configure terminal']);
    const o = offerts(r.cliHelp('enable algorithm-type '));
    expect(o).toContain('scrypt');
    expect(o).not.toContain('secret');
    expect(offerts(r.cliHelp('enable algorithm-type scrypt '))).toContain('secret');
  });

  it('et un routeur n offre plus `clear mac`, qui est un organe de commutateur', async () => {
    const r = await neuf([]);
    expect(offerts(r.cliHelp('clear '))).not.toContain('mac');
    const s = new CiscoSwitch('switch-cisco', 'SWM') as unknown as Dev;
    await s.executeCommand('enable');
    expect(offerts(s.cliHelp('clear '))).toContain('mac');
  });
});

describe('non-regression — un mot-cle incomplet reste propose', () => {
  it('`interface ?` offre les types, et `interface GigabitEthernet` est INCOMPLETE', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('interface '))).toContain('GigabitEthernet');
    // Le mot-cle est bon : la machine doit reclamer la suite, pas nier le mot.
    expect(String(await r.executeCommand('interface GigabitEthernet')))
      .toContain('Incomplete');
  });

  it('et `interface GigabitEthernet0/0` s execute', async () => {
    const r = await neuf(['configure terminal']);
    expect(String(await r.executeCommand('interface GigabitEthernet0/0')))
      .not.toContain('Invalid input');
  });

  it('le commutateur repond la MEME chose au meme type sans numero', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SWP') as unknown as Dev;
    for (const c of ['enable', 'configure terminal']) await s.executeCommand(c);
    expect(offerts(s.cliHelp('interface '))).toContain('FastEthernet');
    // Il repondait « % Invalid interface name », c'est-a-dire « ce nom
    // n'existe pas » a un nom que son aide venait de proposer.
    expect(String(await s.executeCommand('interface FastEthernet')))
      .toContain('Incomplete');
    expect(String(await s.executeCommand('interface FastEthernet0/1')))
      .not.toContain('Invalid');
  });

  it('et garde « nom invalide » pour un nom qui l est vraiment', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SWQ') as unknown as Dev;
    for (const c of ['enable', 'configure terminal']) await s.executeCommand(c);
    expect(String(await s.executeCommand('interface FastEthernet9/9')))
      .toContain('Invalid interface name');
  });
});
