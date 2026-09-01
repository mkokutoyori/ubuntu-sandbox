/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS, sur deux
 * commandes d'interface que le ROUTEUR sert deja par le socle et dont le
 * COMMUTATEUR garde une copie ecrite a la main.
 *
 * Ce que la reference dit :
 *   - `mtu <octets>` fixe la taille maximale de la trame sur
 *     l'interface, et une valeur hors des bornes de la plateforme est
 *     REFUSEE.
 *   - `load-interval <secondes>` fixe la fenetre de calcul des
 *     statistiques de charge. La valeur est un MULTIPLE DE 30, de 30 a
 *     600 : c'est la seule des deux dont la contrainte ne soit pas un
 *     simple intervalle, et une valeur comme 45 doit donc etre refusee
 *     bien qu'elle soit dans la plage.
 *   - les deux se relisent dans la configuration rendue, qui est
 *     REJOUEE a l'import d'une topologie.
 *   - un argument qui n'est pas un nombre est refuse.
 *
 * Ce que cette sonde cherche avant tout : que les DEUX plateformes
 * repondent la meme chose, puisque la commande est la meme et que
 * l'IOS est le meme.
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
  await jouer(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'interface FastEthernet0/1']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Invalid MTU|Ambiguous/;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`mtu\` sur un ${nom}`, () => {
    it('une valeur valide se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('mtu 1400')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^\s*mtu 1400\s*$/m);
    });

    it('un argument qui n est pas un nombre est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('mtu zorglub')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/mtu zorglub/);
    });

    it('une valeur TROP PETITE est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('mtu 10')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/^\s*mtu 10\s*$/m);
    });

    it('une valeur TROP GRANDE est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('mtu 99999')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/mtu 99999/);
    });

    it('la commande sans argument est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('mtu')).toMatch(/Incomplete command/);
    });

    it('l aide de la place annonce une PLAGE', async () => {
      const d = await fabrique();
      expect(d.cliHelp('mtu ')).toMatch(/<\d+-\d+>/);
    });
  });

  describe(`\`load-interval\` sur un ${nom}`, () => {
    it('un multiple de 30 se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('load-interval 60')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^\s*load-interval 60\s*$/m);
    });

    it('une valeur qui n est PAS un multiple de 30 est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('load-interval 45')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/load-interval 45/);
    });

    it('une valeur sous 30 est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('load-interval 10')).toMatch(REFUS);
    });

    it('une valeur au-dessus de 600 est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('load-interval 900')).toMatch(REFUS);
    });

    it('un argument qui n est pas un nombre est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('load-interval zorglub')).toMatch(REFUS);
    });

    it('l aide de la place annonce <30-600>', async () => {
      const d = await fabrique();
      expect(d.cliHelp('load-interval ')).toContain('<30-600>');
    });
  });
}

/*
 * Le plafond de MTU depend du PORT et non du medium : une interface de
 * bouclage n'emet aucune trame, donc 9216 — la taille d'une trame
 * Ethernet jumbo — n'a pas de sens pour elle, et ce depot lui donne
 * 65536 comme le noyau donne a `lo`. Une plage ECRITE dans la
 * declaration l'ignorerait et refuserait une valeur que la machine
 * accepte : la plage est donc consultative, et c'est `Port.setMTU` qui
 * tranche, la plage annoncee suivant le port selectionne.
 */
describe('le plafond de MTU vient du PORT, pas de la declaration', () => {
  it('le refus NOMME le plafond et sa raison', async () => {
    const r = await routeur();
    expect(await r.executeCommand('mtu 65536'))
      .toContain('% Invalid MTU: 65536. Maximum is 9216 (jumbo frame).');
  });

  it('l aide annonce le plafond du port selectionne', async () => {
    const r = await routeur();
    expect(r.cliHelp('mtu ')).toContain('<68-9216>');
  });

  /*
   * Une `Loopback0` de Cisco n'est PAS un port de bouclage au sens de
   * `Port` — seul `LinuxMachine` en cree un — donc elle garde le
   * plafond d'Ethernet. C'est mesure et non suppose, et c'est inscrit
   * au `TODO.md` : le plafond de 65536 que ce depot a donne a `lo` ne
   * lui a jamais ete etendu.
   */
  it('une `Loopback0` de Cisco garde le plafond d Ethernet', async () => {
    const r = new CiscoRouter('RL', 0, 0) as unknown as Cli;
    r.powerOn();
    await jouer(r, ['enable', 'configure terminal', 'interface Loopback0']);
    expect(await r.executeCommand('mtu 65536')).toContain('Maximum is 9216');
    expect(r.cliHelp('mtu ')).toContain('<68-9216>');
  });
});

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'mtu zorglub', 'mtu 10', 'mtu 99999', 'mtu',
    'load-interval 45', 'load-interval zorglub', 'load-interval 900',
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

  it('la DESCRIPTION de `mtu` est la meme des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    const decrit = (aide: string): string =>
      (aide.split('\n').find((l) => /^\s+mtu\s/.test(l)) ?? '')
        .trim().replace(/^mtu\s+/, '');
    const cote = decrit(r.cliHelp(''));
    expect(cote.length).toBeGreaterThan(0);
    expect(decrit(s.cliHelp(''))).toBe(cote);
  });

  it('la DESCRIPTION de `load-interval` est la meme des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    const decrit = (aide: string): string =>
      (aide.split('\n').find((l) => /^\s+load-interval\s/.test(l)) ?? '')
        .trim().replace(/^load-interval\s+/, '');
    const cote = decrit(r.cliHelp(''));
    expect(cote.length).toBeGreaterThan(0);
    expect(decrit(s.cliHelp(''))).toBe(cote);
  });
});
