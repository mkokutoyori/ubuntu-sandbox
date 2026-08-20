/**
 * Probes — `bc`, la calculatrice à précision arbitraire.
 *
 * Dernier refus des transcripts `linux-text-pipes`, et le seul de la
 * famille qui ne soit pas un filtre de flux : `bc` a une grammaire et
 * une arithmétique à lui.
 *
 * Cette arithmétique n'est pas celle des flottants, et c'est tout
 * l'enjeu : les valeurs sont des entiers de taille libre accompagnés
 * d'une échelle décimale, les troncatures vont vers zéro, et l'échelle
 * du résultat suit des règles différentes selon l'opération. Un `bc`
 * bâti sur le `number` de JavaScript rendrait `3.3333333333` là où le
 * vrai rend `3.33`, et perdrait `2^200` dès le vingtième chiffre.
 *
 * Chaque sortie attendue ci-dessous a été relevée sur `bc 1.07.1`, sur
 * la même expression. Les cas les plus révélateurs sont ceux qui
 * surprennent : `scale=2;7%3` vaut `.01`, `3.0*2` vaut `6.0`, et un
 * nombre inférieur à un s'écrit sans zéro de tête.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  return pc;
}

const calc = (pc: LinuxPC, expr: string) => pc.executeCommand(`echo "${expr}" | bc`);

describe('Scénario 1 — l\'échelle, opération par opération', () => {
  it('une division tronque à `scale`, zéro par défaut', async () => {
    const pc = lab();
    expect(await calc(pc, '10 / 3')).toBe('3');
    expect(await calc(pc, 'scale=2; 10/3')).toBe('3.33');
    expect(await calc(pc, 'scale=1; 10/4')).toBe('2.5');
    expect(await calc(pc, 'scale=5; 1/7')).toBe('.14285');
  });

  it('une addition garde la plus grande échelle de ses opérandes', async () => {
    const pc = lab();
    // 1.50 a deux décimales : le résultat en garde deux, zéro compris.
    expect(await calc(pc, '1.50+2.5')).toBe('4.00');
    expect(await calc(pc, '2 + 3')).toBe('5');
    expect(await calc(pc, '-5+2')).toBe('-3');
  });

  it('un produit borne son échelle, sans jamais l\'inventer', async () => {
    const pc = lab();
    expect(await calc(pc, 'scale=2; 1.5*1.5')).toBe('2.25');
    // Une décimale à gauche, zéro à droite : le résultat en garde une.
    expect(await calc(pc, '3.0*2')).toBe('6.0');
  });

  it('le modulo se déduit de la division, donc de `scale`', async () => {
    const pc = lab();
    expect(await calc(pc, '7%3')).toBe('1');
    // Surprenant mais exact : à scale=2, 7/3 vaut 2.33, et 7-2.33*3 = .01.
    expect(await calc(pc, 'scale=2;7%3')).toBe('.01');
  });

  it('la puissance accepte un exposant négatif', async () => {
    const pc = lab();
    expect(await calc(pc, '2^10')).toBe('1024');
    expect(await calc(pc, '2^0')).toBe('1');
    expect(await calc(pc, '0^0')).toBe('1');
    expect(await calc(pc, 'scale=3; 2^-2')).toBe('.250');
  });
});

describe('Scénario 2 — la précision est réellement arbitraire', () => {
  it('2^200 rend ses soixante-et-un chiffres', async () => {
    const pc = lab();
    expect(await calc(pc, '2^200'))
      .toBe('1606938044258990275541962092341162602522202993782792835301376');
  });

  it('1/3 à vingt décimales en donne vingt', async () => {
    const pc = lab();
    expect(await calc(pc, 'scale=20; 1/3')).toBe('.33333333333333333333');
  });

  it('`sqrt` tronque, elle n\'arrondit pas', async () => {
    const pc = lab();
    expect(await calc(pc, 'sqrt(16)')).toBe('4');
    expect(await calc(pc, 'scale=4;sqrt(2)')).toBe('1.4142');
    // Le chiffre suivant est un 7 : un arrondi donnerait ...624.
    expect(await calc(pc, 'scale=10; sqrt(2)')).toBe('1.4142135623');
  });
});

describe('Scénario 3 — l\'écriture des nombres', () => {
  it('un nombre inférieur à un s\'écrit sans zéro de tête', async () => {
    const pc = lab();
    expect(await calc(pc, '0.5')).toBe('.5');
    expect(await calc(pc, '-0.5')).toBe('-.5');
  });

  it('`obase` change la base de sortie', async () => {
    const pc = lab();
    expect(await calc(pc, 'obase=2; 10')).toBe('1010');
  });
});

describe('Scénario 4 — variables, affectations et fonctions', () => {
  it('une affectation n\'imprime rien, l\'expression suivante si', async () => {
    const pc = lab();
    expect(await calc(pc, 'x=5')).toBe('');
    expect(await pc.executeCommand('printf "x=5\\nx*2\\n" | bc')).toBe('10');
  });

  it('une variable jamais affectée vaut zéro, ce n\'est pas une erreur', async () => {
    const pc = lab();
    expect(await calc(pc, 'y')).toBe('0');
    expect(await calc(pc, 'scale')).toBe('0');
  });

  it('une comparaison rend un ou zéro', async () => {
    const pc = lab();
    expect(await calc(pc, '3>2')).toBe('1');
    expect(await calc(pc, '2>3')).toBe('0');
  });

  it('`length` et `scale` comptent les chiffres', async () => {
    const pc = lab();
    expect(await calc(pc, 'length(12345)')).toBe('5');
    expect(await calc(pc, 'scale(1.234)')).toBe('3');
  });

  it('`quit` arrête la lecture au milieu du flux', async () => {
    const pc = lab();
    expect(await pc.executeCommand('printf "1+1\\nquit\\n2+2\\n" | bc')).toBe('2');
  });
});

describe('Scénario 5 — les erreurs, dans leur forme réelle', () => {
  it('la division par zéro est une erreur d\'exécution', async () => {
    const pc = lab();
    expect(await calc(pc, '1/0')).toBe('Runtime error (func=(main), adr=3): Divide by zero');
  });

  it('une fonction de la bibliothèque absente est nommée', async () => {
    const pc = lab();
    // Message exact du vrai bc quand la bibliothèque n'est pas chargée.
    expect(await calc(pc, 's(1)')).toBe('Runtime error (func=(main), adr=3): Function s not defined.');
  });

  it('une expression tronquée rend l\'erreur de syntaxe du vrai', async () => {
    const pc = lab();
    expect(await calc(pc, '2 +')).toBe('(standard_in) 1: syntax error');
  });

  it('ce qui n\'est pas implémenté le dit, plutôt que de crier syntaxe', async () => {
    const pc = lab();
    // Répondre « syntax error » à un `define` valide laisserait croire que
    // la ligne est fausse, alors que c'est ce bc qui ne va pas jusque-là.
    const out = await calc(pc, 'define f(x){return(x)}');
    expect(out).toContain("'define' is not supported");
    expect(out).not.toContain('syntax error');
  });

  it('`-l` est refusé plutôt qu\'à moitié tenu', async () => {
    const pc = lab();
    // Accepter -l pour son seul scale=20 laisserait croire que s(), c(),
    // a(), l(), e() et j() répondent.
    expect(await pc.executeCommand('bc -l')).toContain('math library (-l) is not available');
  });
});

describe('Scénario 6 — au bout du tuyau et depuis un fichier', () => {
  it('la somme de `paste -sd+` arrive jusqu\'ici', async () => {
    const pc = lab();
    // Les deux formes du transcript : avec et sans le `-` explicite.
    expect(await pc.executeCommand('seq 1 10 | paste -sd+ | bc')).toBe('55');
    expect(await pc.executeCommand('seq 1 10 | paste -sd+ - | bc')).toBe('55');
  });

  it('un fichier passé en argument est lu', async () => {
    const pc = lab();
    await pc.executeCommand('echo "1+1" > e.bc');
    expect(await pc.executeCommand('bc e.bc')).toBe('2');
    expect(await pc.executeCommand('bc absent.bc')).toContain('is unavailable');
  });
});
