/*
 * Sonde ECRITE A L'AVEUGLE, depuis la documentation IOS des trois
 * familles de redondance de premier saut, et portant sur ce que le
 * SOCLE apporte a une commande que le trie servait deja : une place
 * d'argument TYPEE, donc PARSEE, une abreviation et une ambiguite
 * decidees par le meme mecanisme, et une aide qui decrit chaque place.
 *
 * Ce que la reference dit, place par place :
 *   - le GROUPE est un nombre borne, et la borne depend du protocole :
 *     0-255 pour HSRP version 1, 0-4095 en version 2, 1-255 pour VRRP,
 *     0-1023 pour GLBP. Un mot qui n'est pas un nombre n'est pas un
 *     groupe.
 *   - `priority` prend 0-255 sur les trois.
 *   - `preempt delay minimum <s>` prend des secondes, `timers` des
 *     secondes, `weighting` une valeur — toutes des places NUMERIQUES.
 *   - `ip` prend une adresse, et `standby ip` s'ecrit aussi SANS
 *     adresse (le routeur apprend alors l'adresse du groupe).
 *   - `load-balancing` de GLBP prend l'un de trois mots seulement :
 *     `round-robin`, `host-dependent`, `weighted`.
 *
 * Ce que la reference dit de la SAISIE, et qui vaut pour toute commande
 * d'IOS : une abreviation non ambigue s'execute, une abreviation
 * ambigue repond `% Ambiguous command:`, un mot qui ne prefixe rien
 * repond `% Invalid input detected`.
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

const REFUS = /Invalid input|Incomplete command|Ambiguous command|out of range/;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

/*
 * Les trois plages de PRIORITE different, et ce n'est pas un detail de
 * rendu : VRRP reserve 255 au proprietaire de l'adresse (RFC 5798), donc
 * sa plage configurable s'arrete a 254, tandis que GLBP commence a 1 et
 * HSRP admet 0. Une premiere version de cette sonde exigeait `<0-255>`
 * pour les trois — elle recopiait la plage d'HSRP sur ses deux voisins.
 */
const PROTOCOLES = [
  { mot: 'standby', vip: '10.0.0.254', groupe: 1, priorite: '<0-255>' },
  { mot: 'vrrp', vip: '10.0.0.253', groupe: 2, priorite: '<1-254>' },
  { mot: 'glbp', vip: '10.0.0.252', groupe: 3, priorite: '<1-255>' },
] as const;

for (const [nom, fabrique] of PLATEFORMES) {
  for (const p of PROTOCOLES) {
    describe(`places de \`${p.mot}\` sur un ${nom}`, () => {
      it('un GROUPE qui n est pas un nombre est refuse', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${p.mot} zorglub ip ${p.vip}`)).toMatch(REFUS);
        expect(await conf(d)).not.toMatch(new RegExp(`${p.mot} zorglub`));
      });

      it('une PRIORITE qui n est pas un nombre est refusee', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} ${p.groupe} ip ${p.vip}`);
        expect(await d.executeCommand(`${p.mot} ${p.groupe} priority zorglub`))
          .toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/priority zorglub/);
      });

      it('une PRIORITE hors de 0-255 est refusee', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} ${p.groupe} ip ${p.vip}`);
        expect(await d.executeCommand(`${p.mot} ${p.groupe} priority 300`))
          .toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/priority 300/);
      });

      it('un DELAI de preemption qui n est pas un nombre est refuse', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} ${p.groupe} ip ${p.vip}`);
        expect(await d.executeCommand(`${p.mot} ${p.groupe} preempt delay minimum zorglub`))
          .toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/delay minimum zorglub/);
      });

      it('un REGLAGE inconnu est refuse, pas range en silence', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} ${p.groupe} ip ${p.vip}`);
        expect(await d.executeCommand(`${p.mot} ${p.groupe} zorglub 5`)).toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/zorglub/);
      });

      it('l abreviation non ambigue du protocole s execute', async () => {
        const d = await fabrique();
        const abrege = p.mot.slice(0, 4);
        expect(await d.executeCommand(`${abrege} ${p.groupe} ip ${p.vip}`))
          .not.toMatch(REFUS);
        expect(await conf(d)).toMatch(
          new RegExp(`${p.mot} ${p.groupe} ip ${p.vip.replace(/\./g, '\\.')}`));
      });

      it('l abreviation d un REGLAGE s execute aussi', async () => {
        const d = await fabrique();
        await d.executeCommand(`${p.mot} ${p.groupe} ip ${p.vip}`);
        expect(await d.executeCommand(`${p.mot} ${p.groupe} pri 110`)).not.toMatch(REFUS);
        expect(await conf(d)).toMatch(new RegExp(`${p.mot} ${p.groupe} priority 110`));
      });

      it('l aide de la place du GROUPE annonce une PLAGE', async () => {
        const d = await fabrique();
        expect(d.cliHelp(`${p.mot} `)).toMatch(/<\d+-\d+>/);
      });

      it(`l aide de la place de PRIORITE annonce ${p.priorite}`, async () => {
        const d = await fabrique();
        expect(d.cliHelp(`${p.mot} ${p.groupe} priority `)).toContain(p.priorite);
      });

      it('l aide de la place de l ADRESSE annonce A.B.C.D', async () => {
        const d = await fabrique();
        expect(d.cliHelp(`${p.mot} ${p.groupe} ip `)).toMatch(/A\.B\.C\.D/);
      });
    });
  }

  describe(`bornes propres a chaque protocole sur un ${nom}`, () => {
    it('VRRP refuse le groupe 0 — sa plage commence a 1', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('vrrp 0 ip 10.0.0.253')).toMatch(REFUS);
    });

    it('VRRP refuse le groupe 256', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('vrrp 256 ip 10.0.0.253')).toMatch(REFUS);
    });

    it('GLBP accepte 1023 et refuse 1024', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('glbp 1023 ip 10.0.0.252')).not.toMatch(REFUS);
      expect(await d.executeCommand('glbp 1024 ip 10.0.0.251')).toMatch(REFUS);
    });

    it('HSRP refuse 256 en version 1 et l accepte en version 2', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('standby 256 ip 10.0.0.254')).toMatch(REFUS);
      await d.executeCommand('standby version 2');
      expect(await d.executeCommand('standby 256 ip 10.0.0.254')).not.toMatch(REFUS);
    });

    it('GLBP `load-balancing` n accepte que ses trois mots', async () => {
      const d = await fabrique();
      await d.executeCommand('glbp 3 ip 10.0.0.252');
      expect(await d.executeCommand('glbp 3 load-balancing zorglub')).toMatch(REFUS);
      expect(await d.executeCommand('glbp 3 load-balancing weighted')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/glbp 3 load-balancing weighted/);
    });

    it('l aide de `load-balancing` annonce ses trois mots', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('glbp 3 load-balancing ');
      expect(aide).toMatch(/round-robin/);
      expect(aide).toMatch(/host-dependent/);
      expect(aide).toMatch(/weighted/);
    });
  });
}

describe('les deux plateformes REFUSENT avec les memes mots', () => {
  const SAISIES = [
    'standby zorglub ip 10.0.0.254',
    'standby 1 priority zorglub',
    'vrrp 0 ip 10.0.0.253',
    'glbp 1024 ip 10.0.0.252',
    'glbp 1 load-balancing zorglub',
  ];
  for (const saisie of SAISIES) {
    it(`\`${saisie}\``, async () => {
      const r = await routeur(); const s = await commutateur();
      const nettoie = (t: string) => t.replace(/\^/g, '').replace(/\s+/g, ' ').trim();
      const cote = nettoie(await r.executeCommand(saisie));
      expect(cote.length).toBeGreaterThan(0);
      expect(nettoie(await s.executeCommand(saisie))).toBe(cote);
    });
  }
});

describe('TEMOINS — ce que la migration ne doit pas casser', () => {
  it('un groupe complet se pose et se relit des deux cotes', async () => {
    for (const fabrique of [routeur, commutateur]) {
      const d = await fabrique();
      await jouer(d, ['standby 1 ip 10.0.0.254', 'standby 1 priority 110',
        'standby 1 preempt', 'standby 1 timers 1 5', 'standby 1 name LAN']);
      const texte = await conf(d);
      expect(texte).toMatch(/standby 1 ip 10\.0\.0\.254/);
      expect(texte).toMatch(/standby 1 priority 110/);
      expect(texte).toMatch(/standby 1 preempt/);
      expect(texte).toMatch(/standby 1 timers 1 5/);
      expect(texte).toMatch(/standby 1 name LAN/);
    }
  });

  it('`no <protocole> <groupe>` supprime le groupe entier', async () => {
    for (const p of PROTOCOLES) {
      const d = await routeur();
      await d.executeCommand(`${p.mot} ${p.groupe} ip ${p.vip}`);
      await d.executeCommand(`no ${p.mot} ${p.groupe}`);
      expect(await conf(d)).not.toMatch(new RegExp(`${p.mot} ${p.groupe} ip`));
    }
  });

  it('une commande VOISINE en `s` reste atteignable sur un commutateur', async () => {
    const s = await commutateur();
    await jouer(s, ['exit', 'interface FastEthernet0/1']);
    expect(await s.executeCommand('shutdown')).not.toMatch(REFUS);
    expect(await s.executeCommand('spanning-tree portfast')).not.toMatch(REFUS);
  });
});
