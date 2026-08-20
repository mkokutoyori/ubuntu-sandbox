/**
 * La colorisation du terminal Linux.
 *
 * Constaté en capture d'écran : `echo -e "\e[31mrouge"` imprimait sa
 * propre séquence. `\e` — l'échappement qui OUVRE toute séquence ANSI,
 * donc la seule façon pour un apprenant de produire une couleur à la
 * main — tombait dans le `default` de `processEchoEscapes` et repartait
 * littéral. `printf` avait le même trou, et c'est pire : `echo -e`
 * n'est pas POSIX, `printf` est la forme portable.
 *
 * Le parseur, lui, ne connaissait que 0/1/22/30-37/40-47/90-107 : ni
 * palette 256, ni couleur vraie, ni italique/souligné/atténué/inverse —
 * alors que `TextStyle` porte déjà ces trois derniers champs et que le
 * rendu sait les afficher. Seul le parseur ne les produisait jamais.
 */
import { describe, it, expect } from 'vitest';
import { parseAnsiToSegments } from '@/terminal/core/OutputFormatter';
import { BashInterpreter } from '@/bash/interpreter/BashInterpreter';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';

/** Ce que le shell écrit réellement, séquences comprises. */
function sortie(ligne: string): string {
  const tokens = new BashLexer().tokenize(ligne);
  const ast = new BashParser().parse(tokens);
  const interp = new BashInterpreter({ executeCommand: () => '' });
  const res = interp.execute(ast) as unknown;
  return typeof res === 'string' ? res : String((res as { output?: string })?.output ?? '');
}

describe('`\\e` ouvre une séquence, il ne s\'imprime pas', () => {
  it('`echo -e` produit un vrai ESC', () => {
    expect(sortie('echo -e "\\e[31mrouge\\e[0m"')).toContain('\x1b[31mrouge\x1b[0m');
  });

  it('`\\E` majuscule aussi — bash accepte les deux', () => {
    expect(sortie('echo -e "\\E[32mvert"')).toContain('\x1b[32mvert');
  });

  it('`printf` aussi, et c\'est la forme portable', () => {
    expect(sortie('printf "\\e[35mmagenta\\e[0m\\n"')).toContain('\x1b[35mmagenta\x1b[0m');
  });

  it('sans `-e`, `echo` laisse la séquence littérale — comme bash', () => {
    const out = sortie('echo "\\e[31mrouge"');
    expect(out).toContain('\\e[31mrouge');
    expect(out).not.toContain('\x1b');
  });

  it('les autres échappements manquants suivent : \\f, \\v, \\uXXXX', () => {
    expect(sortie('echo -e "a\\fb"')).toContain('a\fb');
    expect(sortie('echo -e "a\\vb"')).toContain('a\vb');
    expect(sortie('echo -e "\\u00e9"')).toContain('é');
  });
});

describe('le parseur rend toute la palette', () => {
  const style = (texte: string, i = 0) => parseAnsiToSegments(texte)[i].style ?? {};

  it('les seize couleurs de base, et le gras qui les éclaircit', () => {
    expect(style('\x1b[31mx').color).toBe('#cc0000');
    expect(style('\x1b[1;31mx').color).toBe('#ef2929');
    expect(style('\x1b[91mx').color).toBe('#ef2929');
  });

  it('la palette 256 : cube de couleurs et rampe de gris', () => {
    // 196 = 16 + 36*5 + 6*0 + 0 → (255, 0, 0)
    expect(style('\x1b[38;5;196mx').color).toBe('#ff0000');
    // 46 = 16 + 36*0 + 6*5 + 0 → (0, 255, 0)
    expect(style('\x1b[38;5;46mx').color).toBe('#00ff00');
    // Les seize premiers indices retombent sur les couleurs de base.
    expect(style('\x1b[38;5;1mx').color).toBe('#cc0000');
    // 244 = 8 + 10*12 = 128 de gris.
    expect(style('\x1b[38;5;244mx').color).toBe('#808080');
  });

  it('le cube n\'est PAS une rampe linéaire — le premier pas saute à 95', () => {
    // 16 + 1 → composante bleue au premier niveau non nul.
    expect(style('\x1b[38;5;17mx').color).toBe('#00005f');
  });

  it('la couleur vraie, au premier plan comme au fond', () => {
    expect(style('\x1b[38;2;255;128;0mx').color).toBe('#ff8000');
    expect(style('\x1b[48;2;0;80;160mx').backgroundColor).toBe('#0050a0');
  });

  it('italique, souligné, atténué', () => {
    expect(style('\x1b[3mx').italic).toBe(true);
    expect(style('\x1b[4mx').underline).toBe(true);
    expect(style('\x1b[2mx').dim).toBe(true);
  });

  it('`7` échange vraiment le premier plan et le fond', () => {
    const s = style('\x1b[31;47;7mx');
    expect(s.color).toBe('#d3d7cf');
    expect(s.backgroundColor).toBe('#cc0000');
  });

  it('chaque attribut a son extinction propre', () => {
    // `24` éteint le souligné SANS toucher à la couleur : c'est ce que
    // l'œil ne peut pas trancher sur une capture.
    const segs = parseAnsiToSegments('\x1b[4;31msouligne\x1b[24m plus souligne');
    expect(segs[0].style?.underline).toBe(true);
    expect(segs[1].style?.underline).toBeUndefined();
    expect(segs[1].style?.color).toBe('#cc0000');

    expect(style('\x1b[3mx\x1b[23my', 1).italic).toBeUndefined();
    expect(style('\x1b[1mx\x1b[22my', 1).bold).toBeUndefined();
    expect(style('\x1b[7mx\x1b[27my', 1).backgroundColor).toBeUndefined();
  });

  it('`39`/`49` reviennent aux couleurs par défaut sans tout réinitialiser', () => {
    const segs = parseAnsiToSegments('\x1b[1;31mx\x1b[39my');
    expect(segs[1].style?.color).toBeUndefined();
    expect(segs[1].style?.bold, 'le gras ne doit pas tomber avec la couleur').toBe(true);
  });

  it('une séquence tronquée ne fait pas dérailler le reste', () => {
    expect(parseAnsiToSegments('\x1b[38;5mx').map((s) => s.text).join('')).toBe('x');
    expect(parseAnsiToSegments('\x1b[38;2;300;0;0mx')[0].style?.color).toBeUndefined();
  });
});

/**
 * `grep --color` : l'option etait analysee puis JETEE — un `continue`
 * sans rien stocker — donc `grep --color=always` rendait exactement la
 * meme sortie que sans, et le motif trouve ne se distinguait de rien.
 */
describe('`grep --color` entoure ce qu\'il a trouve', () => {
  const ON = '\u001b[01;31m';
  const OFF = '\u001b[m';
  const grep = async (args: string[], contenu: string) => {
    const { cmdGrep } = await import('@/network/devices/linux/LinuxTextCommands');
    // `cmdGrep(ctx, args, stdin)` : le contexte porte le VFS, qu'on ne
    // touche pas ici puisqu'on ne lit que l'entree standard.
    const ctx = { fs: { normalizePath: (p: string) => p }, cwd: '/' };
    return cmdGrep(ctx as never, args, contenu, 'grep').output;
  };

  it('la correspondance porte le gras rouge de GNU grep', async () => {
    const out = await grep(['--color=always', 'root'], 'root:x:0:0\ndaemon:x:1:1\n');
    expect(out).toContain(`${ON}root${OFF}:x:0:0`);
    expect(out).not.toContain('daemon');
  });

  it('sans l\'option, la sortie reste nue', async () => {
    expect(await grep(['root'], 'root:x:0:0\n')).not.toContain('\u001b');
  });

  it('`--color=never` eteint explicitement', async () => {
    expect(await grep(['--color=never', 'root'], 'root:x:0:0\n')).not.toContain('\u001b');
  });

  it('toutes les occurrences d\'une ligne sont entourees', async () => {
    const out = await grep(['--color=always', 'ab'], 'ab-ab-ab\n');
    expect(out.split(ON).length - 1).toBe(3);
  });

  it('deux motifs qui se recouvrent ne s\'imbriquent pas', async () => {
    const out = await grep(['--color=always', '-e', 'abc', '-e', 'bcd'], 'xabcdy\n');
    expect(out.trimEnd()).toBe(`x${ON}abcd${OFF}y`);
  });
});
