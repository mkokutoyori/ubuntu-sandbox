/**
 * Une plage annoncee par `?` est une plage APPLIQUEE.
 *
 * Mesure de depart : en parcourant `cliHelp`, 99 places d'argument
 * decrivent leur valeur par une plage `<min-max>` ; le garde-fou de ce
 * fichier nomme celles qui acceptaient une valeur au-dessus du maximum
 * annonce.
 *
 * Discrimination par `git stash` : 7 des 11 cas tombent avant
 * correctif, et le garde-fou nomme alors les quinze places fautives
 * (`ip ssh time-out 121`, `track 1001`, `router bgp 65536`,
 * `radius-server acct-port 65536`, `tacacs-server timeout 1001`,
 * `access-list 2700`, `priority-list 17`, `queue-list 17`...).
 *
 * `router bgp` a depuis change de PLAGE, et le cas a suivi : IOS accepte
 * les numeros de systeme autonome sur quatre octets (RFC 6793, forme
 * asplain), l'aide annonce `<1-4294967295>`, donc 65536 est DEDANS et
 * doit etre accepte. Le cas porte desormais sur la borne reellement
 * annoncee — 4294967296 et 0 — et verifie l'annonce avant de l'eprouver,
 * pour que le jour ou la plage rebouge, c'est l'annonce qui le dise.
 *
 * Les quatre autres sont nommes plutot que laisses a decouvrir. Le
 * TEMOIN et les deux NON-REGRESSION passent des deux cotes, et c'est
 * leur objet. « Un refus de sous-mode n'est plus rattrape par l'arbre
 * global » passe aussi des deux cotes, pour une raison qui ne prouve
 * rien du defaut d'origine : avant correctif, `spanning-tree cost 0`
 * etait refuse par son propre gestionnaire. Il garde la REGRESSION que
 * ce lot a introduite puis refermee — le refus d'argument etait rejoue
 * contre l'arbre global, qui l'acceptait en silence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

interface Cli { executeCommand(c: string): Promise<string> | string; cliHelp(s: string): string }

async function config(): Promise<Cli> {
  const r = new CiscoRouter('R1') as unknown as Cli;
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

const refuse = (out: string) => out.includes('Invalid input');

describe('IOS : une valeur hors de la plage annoncee est refusee', () => {
  it('TEMOIN — une valeur DANS la plage est acceptee', async () => {
    const r = await config();

    expect(await r.executeCommand('ip ssh time-out 120')).not.toContain('Invalid');
    expect(await r.executeCommand('track 1000 ip route 10.0.0.0 255.0.0.0 reachability'))
      .not.toContain('Invalid');
  });

  it('`ip ssh time-out` refuse au-dela de ce que `?` annonce', async () => {
    const r = await config();
    expect(r.cliHelp('ip ssh time-out ')).toContain('<1-120>');

    expect(refuse(String(await r.executeCommand('ip ssh time-out 121')))).toBe(true);
  });

  it('`track` refuse au-dela de sa plage', async () => {
    const r = await config();

    expect(refuse(String(await r.executeCommand('track 1001')))).toBe(true);
  });

  it('`router bgp` refuse un numero de systeme autonome hors plage', async () => {
    const r = await config();
    expect(r.cliHelp('router bgp ')).toContain('<1-4294967295>');

    expect(refuse(String(await r.executeCommand('router bgp 4294967296')))).toBe(true);
    expect(refuse(String(await r.executeCommand('router bgp 0')))).toBe(true);
  });

  it('une plage declaree par une CONTINUATION est appliquee elle aussi', async () => {
    const r = await config();
    expect(r.cliHelp('radius-server acct-port ')).toContain('<0-65535>');

    expect(refuse(String(await r.executeCommand('radius-server acct-port 65536')))).toBe(true);
    expect(refuse(String(await r.executeCommand('tacacs-server timeout 1001')))).toBe(true);
  });

  it('`access-list`, `priority-list` et `queue-list` refusent hors plage', async () => {
    const r = await config();

    expect(refuse(String(await r.executeCommand('access-list 2700 permit any')))).toBe(true);
    expect(refuse(String(await r.executeCommand('priority-list 17 default normal')))).toBe(true);
    expect(refuse(String(await r.executeCommand('queue-list 17 default 1')))).toBe(true);
  });

  it('un refus de sous-mode n\'est plus rattrape par l\'arbre global', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8) as unknown as Cli;
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');

    expect(refuse(String(await sw.executeCommand('spanning-tree cost 0')))).toBe(true);
    expect(refuse(String(await sw.executeCommand('spanning-tree cost 200000001')))).toBe(true);
    expect(await sw.executeCommand('spanning-tree cost 1')).not.toContain('Invalid');
  });

  it('NON-REGRESSION — une commande globale tapee depuis un sous-mode navigue encore', async () => {
    const r = await config();
    await r.executeCommand('interface GigabitEthernet0/0.10');
    await r.executeCommand('ip vrf RED');

    expect(await (r as unknown as { getPrompt(): Promise<string> }).getPrompt())
      .toBe('R1(config-vrf)#');
  });

  it('NON-REGRESSION — un jeton NON numerique n\'est pas juge par cette regle', async () => {
    const r = await config();
    await r.executeCommand('end');

    expect(await r.executeCommand('delete flash:jamais.cfg')).toContain('No such file');
    expect(refuse(String(await r.executeCommand('disconnect all')))).toBe(false);
  });

  it('`ping` annonce WORD, et prend un nom d\'hote', async () => {
    const r = new CiscoRouter('R1') as unknown as Cli;
    await r.executeCommand('enable');

    expect(r.cliHelp('ping ')).toContain('WORD');
    expect(refuse(String(await r.executeCommand('ping unnom')))).toBe(false);
  });
});

describe('IOS : le garde-fou — aucune plage annoncee ne reste inappliquee', () => {
  const CONNUS = new Set([
    'default logging buffered 8',
    'no logging buffered 8',
  ]);

  it('parcourt l\'aide et n\'accepte rien hors de ce qu\'elle annonce', async () => {
    const r = await config();
    const acceptes: string[] = [];
    const vus = new Set<string>();

    const reprendre = async () => {
      await r.executeCommand('end');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
    };

    const essayer = async (ligne: string) => {
      await reprendre();
      if (String(await r.executeCommand(ligne)).trim() === '') acceptes.push(ligne);
    };

    const visiter = async (prefixe: string, reste: number): Promise<void> => {
      if (reste === 0) return;
      await reprendre();
      const help = r.cliHelp(prefixe);
      if (help.includes('Invalid input') || help.includes('Ambiguous') || help.trim() === '') return;
      const maxima: number[] = [];
      for (const ligne of help.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const i = ligne.search(/\s{2,}/);
        const mot = i < 0 ? ligne : ligne.slice(0, i);
        if (mot === '<cr>' || mot.startsWith('%')) continue;
        const plage = /^<(\d+)-(\d+)>$/.exec(mot);
        if (plage) {
          const cle = `${prefixe}|${mot}`;
          if (vus.has(cle)) continue;
          vus.add(cle);
          maxima.push(Number(plage[2]));
          continue;
        }
        if (/^[<A-Z]/.test(mot)) continue;
        await visiter(`${prefixe}${mot} `, reste - 1);
      }
      if (maxima.length > 0) await essayer(`${prefixe}${Math.max(...maxima) + 1}`);
    };

    await visiter('', 4);

    expect(vus.size).toBeGreaterThan(90);
    expect(acceptes.filter((a) => !CONNUS.has(a))).toEqual([]);
  }, 120000);
});
