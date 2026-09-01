/*
 * Sonde ECRITE A L'AVEUGLE, avant toute lecture du code, depuis la
 * documentation IOS des trois protocoles de redondance de premier saut
 * portes par une interface : `standby` (HSRP), `vrrp` et `glbp`.
 *
 * Ce que la reference dit, et que les cas ci-dessous exigent :
 *   - chacun se configure par GROUPE : `standby <groupe> ip <adresse>`,
 *     `vrrp <groupe> ip <adresse>`, `glbp <groupe> ip <adresse>`.
 *   - `priority` par defaut vaut 100 pour les trois ; `preempt` est
 *     DESACTIVE par defaut sur HSRP et GLBP, ACTIVE sur VRRP (c'est la
 *     RFC 5798 qui l'impose, et c'est la difference la plus citee entre
 *     HSRP et VRRP).
 *   - la configuration rendue est REJOUEE a l'import d'une topologie :
 *     ce qui n'y paraît pas est perdu.
 *   - un Catalyst porte les trois sur sa SVI, l'IOS etant le meme — un
 *     commutateur de distribution est meme l'endroit le plus courant ou
 *     on les configure.
 *
 * Discrimine par `git stash` : 30 des 68 cas tombent avant correctif, et
 * ils sont massivement du cote du ROUTEUR — c'est lui qui ne rendait
 * AUCUNE ligne de redondance dans sa configuration. Les 38 qui passent
 * des deux cotes sont de trois sortes, nommees ici plutot que laissees a
 * decouvrir :
 *   - le COMMUTATEUR faisait deja tout ce que la configuration et les
 *     vues observent ; c'est SA moitie qui sert de reference.
 *   - les cas de REFUS d'une adresse malformee passaient du cote du
 *     commutateur, qui validait deja.
 *   - « la priorite par DEFAUT ne paraît pas » passait des deux cotes
 *     pour deux raisons opposees : le commutateur l'omettait a juste
 *     titre, le routeur ne rendait rien du tout.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

async function jouer(d: Cli, lignes: string[]): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  await jouer(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'ip routing', 'interface Vlan1',
    'ip address 10.0.0.2 255.255.255.0', 'no shutdown']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

const PROTOCOLES = [
  { mot: 'standby', vue: 'show standby', vip: '10.0.0.254' },
  { mot: 'vrrp', vue: 'show vrrp', vip: '10.0.0.253' },
  { mot: 'glbp', vue: 'show glbp', vip: '10.0.0.252' },
] as const;

for (const [nom, fabrique] of PLATEFORMES) {
  for (const p of PROTOCOLES) {
    describe(`\`${p.mot}\` sur un ${nom}`, () => {
      it('un groupe se declare avec son adresse virtuelle', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${p.mot} 1 ip ${p.vip}`))
          .not.toMatch(/Invalid input|Incomplete|Ambiguous|rejected/);
        expect(await conf(d)).toMatch(
          new RegExp(`^\\s*${p.mot} 1 ip ${p.vip.replace(/\./g, '\\.')}\\s*$`, 'm'));
      });

      it('la priorite se pose et se relit', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} 1 ip ${p.vip}`);
        expect(await d.executeCommand(`${p.mot} 1 priority 110`))
          .not.toMatch(/Invalid input|Incomplete|Ambiguous/);
        expect(await conf(d)).toMatch(new RegExp(`^\\s*${p.mot} 1 priority 110\\s*$`, 'm'));
      });

      it('la priorite par DEFAUT ne paraît pas', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} 1 ip ${p.vip}`);
        expect(await conf(d)).not.toMatch(new RegExp(`${p.mot} 1 priority`));
      });

      /*
       * VRRP preempte par DEFAUT (RFC 5798), HSRP et GLBP non. C'est ce
       * qui rend leur rendu asymetrique : sur HSRP et GLBP c'est
       * `preempt` qui s'ecrit, sur VRRP c'est `no ... preempt`. Une
       * premiere version de ce cas exigeait la ligne `vrrp 1 preempt`
       * dans la configuration, donc elle exigeait qu'un DEFAUT soit
       * ecrit — ce qu'aucun IOS ne fait.
       */
      it('`preempt` se pose, et seul l ECART au defaut est rendu', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} 1 ip ${p.vip}`);
        expect(await d.executeCommand(`${p.mot} 1 preempt`))
          .not.toMatch(/Invalid input|Incomplete|Ambiguous/);
        const texte = await conf(d);
        if (p.mot === 'vrrp') expect(texte).not.toMatch(/vrrp 1 preempt/);
        else expect(texte).toMatch(new RegExp(`${p.mot} 1 preempt`));
      });

      it('couper `preempt` sur VRRP se REND, parce que c est l ecart', async () => {
        if (p.mot !== 'vrrp') return;
        const d = await fabrique();
        await d.executeCommand(`${p.mot} 1 ip ${p.vip}`);
        await d.executeCommand(`no ${p.mot} 1 preempt`);
        expect(await conf(d)).toMatch(/no vrrp 1 preempt/);
      });

      it('la vue nomme le groupe et son adresse virtuelle', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} 1 ip ${p.vip}`);
        await jouer(d, ['end']);
        const vue = await d.executeCommand(p.vue);
        expect(vue).not.toMatch(/Invalid input/);
        expect(vue).toContain(p.vip);
      });

      it('deux groupes coexistent sur une meme interface', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} 1 ip ${p.vip}`);
        await d.executeCommand(`${p.mot} 2 ip 10.0.0.240`);
        const texte = await conf(d);
        expect(texte).toMatch(new RegExp(`${p.mot} 1 ip`));
        expect(texte).toMatch(new RegExp(`${p.mot} 2 ip`));
      });

      it('un numero de groupe hors plage est REFUSE', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${p.mot} 99999 ip ${p.vip}`))
          .toMatch(/Invalid input|out of range|Incomplete/);
      });

      it('une adresse virtuelle malformee est REFUSEE', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${p.mot} 1 ip zorglub`))
          .toMatch(/Invalid input|Incomplete/);
        expect(await conf(d)).not.toMatch(new RegExp(`${p.mot} 1 ip zorglub`));
      });

      it('l aide annonce le groupe puis ses reglages', async () => {
        const d = await fabrique();
        expect(d.cliHelp(`${p.mot} `)).not.toMatch(/Invalid input/);
        const aide = d.cliHelp(`${p.mot} 1 `);
        expect(aide).toMatch(/^\s+ip\b/m);
        expect(aide).toMatch(/^\s+priority\b/m);
        expect(aide).toMatch(/^\s+preempt\b/m);
      });
    });
  }
}

describe('les deux plateformes repondent la MEME chose', () => {
  for (const p of PROTOCOLES) {
    it(`la DESCRIPTION de \`${p.mot}\` est la meme des deux cotes`, async () => {
      const r = await routeur(); const s = await commutateur();
      const decrit = (aide: string): string =>
        (aide.split('\n').find((l) => new RegExp(`^\\s+${p.mot}\\s`).test(l)) ?? '')
          .trim().replace(new RegExp(`^${p.mot}\\s+`), '');
      const cote = decrit(r.cliHelp(''));
      expect(cote.length).toBeGreaterThan(0);
      expect(decrit(s.cliHelp(''))).toBe(cote);
    });

    it(`la ligne de configuration de \`${p.mot}\` est ECRITE PAREIL`, async () => {
      const r = await routeur(); const s = await commutateur();
      await r.executeCommand(`${p.mot} 1 ip ${p.vip}`);
      await s.executeCommand(`${p.mot} 1 ip ${p.vip}`);
      const ligne = (texte: string): string =>
        (texte.split('\n').find((l) => l.includes(`${p.mot} 1 ip`)) ?? '');
      expect(ligne(await conf(s))).toBe(ligne(await conf(r)));
    });
  }
});

describe('TEMOINS — ce qui marchait garde son comportement', () => {
  it('une route statique se pose et se relit', async () => {
    const r = await routeur();
    await jouer(r, ['exit', 'ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
    expect(await conf(r)).toMatch(/ip route 10\.9\.0\.0 255\.255\.0\.0 10\.0\.0\.254/);
  });

  it('`ip helper-address` se pose toujours des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    await r.executeCommand('ip helper-address 10.9.9.9');
    await s.executeCommand('ip helper-address 10.9.9.9');
    expect(await conf(r)).toMatch(/ip helper-address 10\.9\.9\.9/);
    expect(await conf(s)).toMatch(/ip helper-address 10\.9\.9\.9/);
  });
});
