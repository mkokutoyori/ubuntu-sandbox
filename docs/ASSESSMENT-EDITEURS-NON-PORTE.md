# Editeurs (vi, vim, nano) et geometrie du terminal : ce qui n'est pas porte, ce qui n'est pas atteste

Ce document est le releve de ce que le chantier « coherence du curseur et du texte »
(tabulations, redimensionnement, defilement, SSH) ne reproduit pas, ou reproduit sans
pouvoir l'attester contre un vrai binaire. Il remplace les listes de limites qui
n'existaient que dans les messages de commit et les en-tetes de sondes.

Trois statuts, jamais melanges :

- **Non porte** : la brique manque ; le simulateur refuse ou fait autre chose que le vrai logiciel.
- **Accepte sans effet** : la configuration est lue, rendue et ignoree. Chaque entree est un
  ecart a fermer (`CLAUDE.md`, regle 6). Les entrees marquees « prealable » existaient avant ce
  chantier et n'ont pas ete creees par lui.
- **Non atteste** : le simulateur fait un choix raisonnable que le corpus enregistre ne
  permet pas de comparer (le corpus compare le TEXTE des rangees et la CELLULE du curseur,
  pas les attributs d'affichage).

## 0. Methode et corpus

Les modeles d'ecran sont rejoues contre des binaires reels pilotes par tmux :

| Sujet | Binaire | Generateur | Corpus | Test |
| --- | --- | --- | --- | --- |
| Ecran de vim | vim 9.1, `-u DEFAULTS --noplugin -i NONE -n` | `scripts/oracle/record_vim_screen.py` | cells 400, scroll 250, resize 200, click 2 x 200 (seeds 9 et 21) | `vim-screen-oracle.test.ts` |
| Curseur et tampon de vim | vim 9.1, `-u NONE -es` | `scripts/oracle/record_vim_cursor.py` | edit 1200, search 700, tabs 900, visual 2 x 800, insert 2 x 800 (seeds 12, 31, 40, 61, 62, 71, 72) | `vim-cursor-oracle.test.ts` |
| Options de vim | vim 9.1 | `scripts/oracle/record_vim_options.py` | table des options et de leurs messages | `probe-vim-options-moteur.test.ts` |
| Ecran de nano | nano 7.2, `-I` | `scripts/oracle/record_nano_screen.py` | cells 150, scroll 200, resize 150, prompts 3 x 150 (seeds 7, 13, 17) | `nano-screen-oracle.test.ts` |
| Taille du tty | bash 5.2, stty 9.4, six tailles de pty | `scripts/oracle/record_tty_geometry.py` | six tailles | `tty-window-size.test.ts` |

Etat mesure : vim 1249 cas sur 1250 (cellules du curseur comprises), plus 6000 transcripts de curseur et de tampon (dont 2 x 800 en mode Visuel et 2 x 800 en mode Insertion), nano 949 cas sur 950,
tty six tailles sur six. Les corpus prompts seed 13 et seed 17 ont ete enregistres APRES
le code qui les juge : seed 13 a trouve 3 ecarts (corriges), seed 17 est passe 150/150
sans retouche.

## 1. vim

### 1.1 Le cas du corpus que le modele n'atteint pas (`UNPORTED_CASES`)

Aucun n'est epingle comme contrat ; un cas de la liste qui se met a passer fait echouer le test
pour qu'on le retire.

| Famille | Cas | Constat | Statut |
| --- | --- | --- | --- |
| Deux clics sur la meme cellule en moins de 'mousetime' | `clk21-53` | Vim y voit un double-clic et selectionne le mot ; ce moteur y voit deux clics simples. Le navigateur fournit le nombre de clics (`event.detail`), pas une horloge rejouable : le geste reste a mesurer sur un corpus qui separe les clics par des delais connus. | Non porte |

Les 36 autres cas de l'ancien corpus sont rejoues depuis le commit « fenetre de vim : memes decisions de
defilement que move.c » : le moteur reprend les fonctions de `move.c` de vim 9.1.0016 (`update_topline`,
`curs_columns`, `scroll_cursor_top/bot/halfway`, `cursor_correct`, `onepage`, `halfpage`,
`scroll_to_fraction`) avec les memes etats de validite (`w_valid` : `VALID_TOPLINE`, `VALID_BOTLINE`,
`VALID_BOTLINE_AP`, curseur deja deplace) et le meme second passage de `update_topline` apres le
dessin quand `w_botline` a change (`win_update`). Le source de vim n'a pas ete lu de memoire : le
tarball `vim_9.1.0016.orig.tar.gz` de l'archive Ubuntu a ete compile avec des traces et rejoue sur
les memes transcriptions.

### 1.2 Hors corpus

| Element | Statut | Constat |
| --- | --- | --- |
| Caracteres combinants et emoji (largeur 0 / 2 selon `ambiwidth`, sequences ZWJ) | Non porte | `VimCharWidth` suit les plages Unicode des CJK et des accents composes ; une sequence de plusieurs points de code dessinee sur une cellule ou deux place le curseur autrement que vim. |
| Effets de `filetype plugin indent on` | Non porte | `defaults.vim` charge les ftplugins : un fichier `yaml`, `python`, `make`, `sh`... recoit `shiftwidth`, `expandtab`, `softtabstop`, `textwidth` propres a son type. Le moteur applique les valeurs globales seules, donc une tabulation dans un `Makefile` ou une indentation dans un `.yml` calcule la colonne du curseur autrement que vim. |
| Touches d'Insertion hors corpus : Ctrl-R {registre}, Ctrl-V / Ctrl-Q (litteral), Ctrl-O (une commande Normale), Ctrl-K (digraphe), Ctrl-A / Ctrl-@ (reinserer le dernier texte), Ctrl-N / Ctrl-P / Ctrl-X (completion), Ctrl-G u / j / k | Non porte | Ctrl-T, Ctrl-D (et `0 Ctrl-D`, `^ Ctrl-D`), Ctrl-E, Ctrl-Y, Ctrl-F (sans `cindent`), Ctrl-U, Ctrl-W, Ctrl-H, Retour arriere, Tab, Entree et les fleches sont rejoues contre un vrai vim (corpus insert). Les touches listees ici sont ignorees en mode Insertion, sans message. |
| `:set` sans argument | Non porte | Vim liste les options differentes de leur defaut ; le moteur ne rend rien. |
| `hlsearch`, `incsearch`, `showmatch` | Accepte sans effet (prealable) | Les options sont lues, listees (`:set hls?`) et ignorees : aucun surlignage des occurrences, aucune recherche incrementale pendant la frappe de `/`, aucun saut bref sur la parenthese ouvrante. `incsearch` modifie le TEXTE de l'ecran (la fenetre defile jusqu'a l'occurrence pendant la saisie), donc c'est le plus visible. |
| Options de defilement `scrolljump`, `smoothscroll`, `splitkeep` | Non porte | Absentes de la table des options : `:set scrolljump=5` est refuse comme option inconnue, ce qui est la reponse correcte tant qu'aucune regle de defilement ne la lit. `scroll_cursor_*` de `move.c` consomme `p_sj` ; l'ajouter demande de mesurer ses effets sur `scroll_cursor_top/bot`, pas de la stocker. |
| Liste de sauts (`Ctrl-O`, `Ctrl-I`, `:jumps`) | Non porte | Seuls les sauts de marques (`` ` `` et `'`) sont suivis ; ni `G`, ni `gg`, ni les recherches ne s'y inscrivent. |
| Souris de vim : glisser pour selectionner, double-clic (mot), triple-clic (ligne), Maj-clic, clic droit, clic dans la ligne de commande, `ttymouse`, `mousemodel`, `mousescroll`, `mousetime` | Non porte | Le clic simple est porte et rejoue contre un vrai vim (`mouse=` a, n, v, i, c et leurs unions ; vide par defaut, comme un vim Debian/Ubuntu) : il place le curseur sur la cellule cliquee, tabulation et caractere large compris, garde la colonne voulue, clot le mode Visuel, et un clic sous le texte atteint la derniere ligne. La molette defile de trois lignes sans consulter `mouse=`. |
| Styles de l'ecran (`Search`, `IncSearch`, `MatchParen`, colorisation syntaxique) | Non porte | Le corpus compare du texte et une cellule. Ce moteur peint `linenr`, `cursorlinenr`, `nontext`, `special`, `visual`, `colorcolumn`, `modemsg`, `error`. |

## 2. nano

### 2.1 Le cas du corpus que le modele n'atteint pas (`UNPORTED_CASES`)

| Cas | Constat | Statut |
| --- | --- | --- |
| `scr3-36` | En `-S`, Retour arriere a la limite d'un morceau enroule laisse le vrai nano avec un curseur perime (il reste sur l'ancienne cellule jusqu'a la touche suivante). Ce moteur place le curseur ou le texte le met : le defaut de nano est volontairement NON reproduit, c'est la coherence que le chantier cherche. | Ecart voulu |

### 2.2 Hors corpus

| Element | Statut | Constat |
| --- | --- | --- |
| Texte de l'aide (`^G`) | Non porte | Le visualiseur est un ecran de quelques lignes ecrites a la main (« GNU nano Help Text »...), pas le texte d'une vingtaine de pages de nano 7.2 ; il ne defile pas. La mise en page de la barre de titre (« Main nano help text ») et les raccourcis de l'ecran d'aide sont fideles, le CONTENU ne l'est pas. |
| Bascules de la rangee `Write Out` : `M-D` (format DOS), `M-M` (format Mac), `M-A` (ajouter), `M-P` (placer devant), `M-B` (copie de sauvegarde), `^T` (navigateur de fichiers) | Non porte | La barre les annonce comme nano ; seule l'ecriture simple est evaluee. |
| Options de la ligne de commande `-i` (indentation automatique), `-E` (tabulations en espaces), `-w` (pas de coupure), `-T N` (taille de tabulation), `-m` (souris), `-$` | Accepte sans effet (prealable) | `editorLaunch` n'evalue que `-v -c -l -S +L,C` ; tout autre drapeau est lu et ignore au lieu d'etre applique ou refuse. La taille de tabulation reste 8, valeur par defaut de nano. Meme chose pour `vim -R`, `-c CMD`, `-u`, `-O`. |
| Mise en evidence de la recherche (`spotlight` apres `^W`) | Non atteste | Le remplacement surligne l'occurrence interrogee (corpus : texte et curseur, pas l'attribut) ; la recherche simple ne surligne rien. |
| Attributs d'affichage | Non atteste | Titre, numeros de ligne, `<`/`>`, selection, message d'etat, libelles de raccourcis et invite sont en video inverse ; les erreurs sont en gras blanc sur rouge. Releve a la main sur nano 7.2, pas rejoue. |
| Prompt `Write Out` avec le nom tel que tape | Corrige | Le defaut est le nom tape en ligne de commande (`t.txt`), pas le chemin absolu ; le chemin resolu n'est utilise qu'a l'ecriture. |
| Fonctions annoncees par les barres de raccourcis des invites mais non portees : `^T` Go To Line dans la recherche, `^Y` First Line / `^V` Last Line dans la recherche et le remplacement, `M-F` New Buffer, `^S` Spell Check, `M-\` Pipe Text, `^Y` Linter, `^O` Formatter, `^J` Full Justify, `^V` Cut Till End dans `^T` | Non porte | Les barres sont celles de nano 7.2 (rejouees) ; presser une de ces touches dans l'invite ne fait rien, alors que la barre l'annonce. |
| Navigateur de fichiers (`^T` dans `Read File`), `^R` + `M-F` (nouveau tampon), `M-<`/`M->` (tampons multiples) | Non porte | Un seul tampon par session ; le moteur n'a ni liste de tampons ni navigateur. |
| Caracteres combinants et emoji | Non porte | Meme limite que vim. |
| Rehaussement des couleurs de syntaxe (`nanorc`) | Non porte | `nano -I` : aucun fichier de configuration lu, aucun rc applique par le simulateur non plus. |

## 3. Geometrie du terminal (tty, stty, tput)

| Element | Statut | Constat |
| --- | --- | --- |
| `stty` autre que `size`, `-a`, `rows N`, `cols N`, `columns N` | Accepte sans effet | `stty -echo`, `stty sane`, `stty raw`, `stty erase ^H`, `stty -F /dev/pts/N`... : la commande reussit et ne change rien, et un mot inconnu n'est pas refuse (`stty: invalid argument 'x'` chez le vrai). Les modes termios (`icanon`, `echo`, `isig`) ne sont pas modelises : `stty -a` rend les groupes de drapeaux d'un pty vierge. |
| Taille en pixels (`ws_xpixel`, `ws_ypixel`) | Non porte | La taille d'un tty est `rows x cols`. |
| `SIGWINCH` livre a un processus quelconque | Non porte | Les editeurs plein ecran, `stty`, `tput` et les shells lisent la taille ; un processus de fond ne recoit pas le signal. |
| Variables `COLUMNS` et `LINES` d'un shell non interactif | Non atteste | Le corpus rejoue un bash interactif sur pty (`checkwinsize` actif). Un `bash -c` sans tty les laisse non definies, comme le vrai ; la mise a jour apres redimensionnement pendant une commande longue n'est pas rejouee. |
| `tput` : capacites autres que `cols`, `lines` et les sequences muettes (`clear`, `init`, `reset`, `sgr0`, `bold`, `smso`, `rmso`, `cnorm`, `civis`) | Non porte | Une capacite inconnue est refusee (`tput: unknown terminfo capability`), comme le vrai pour un nom qui n'existe pas ; les capacites reelles non listees (`colors`, `smcup`, `cup`...) sont refusees a tort. |
| Console Windows / PowerShell | Non porte | `mode con`, `$Host.UI.RawUI.WindowSize` ne lisent pas la taille du terminal ; seule la famille Linux a une taille de tty. |

## 4. SSH

| Element | Statut | Constat |
| --- | --- | --- |
| `pty-req` et `window-change` (RFC 4254 §6.2 et §6.7) | Fait | Le serveur ouvre l'editeur a la taille annoncee, le redimensionne et pousse la vue (`EDITOR_VIEW`) sans attendre une touche. Sondes : `ssh-editor-screen-geometry.test.ts` (vim), `ssh-nano-screen-geometry.test.ts` (nano), `tty-window-size.test.ts` (shell, `ssh -t`). |
| Clic de souris par SSH | nano seulement | L'action `click` du canal rejoint `NanoEngine.clickAt` ; vim ne l'implemente pas (voir 1.2). |
| Taille changee pendant un `Ctrl-Z` / `fg` | Non atteste | Le moteur d'editeur est detruit a la sortie ; le chemin « suspendre puis reprendre » n'existe pas pour les editeurs. |
| Redimensionnement entre deux sauts SSH (`ssh a` puis `ssh b`) | Fait pour deux sauts | La taille se propage de saut en saut ; non rejoue au-dela de deux sauts. |

## 5. Dette de nettoyage

- `editorRender.ts` est supprime : ses trois familles de fonctions (`renderListLine`,
  `displayNotation`/`displayColumnFor`, les rangees de raccourcis et d'etat de nano) etaient
  des doubles du modele d'ecran (`VimCells`, `NanoText`, `NanoScreen`), l'un et l'autre
  rejoues contre le vrai binaire. Les tests qui interrogeaient `renderListLine` lisent
  maintenant `engine.screen`.
- Les specs e2e `nano-*`, `editor-*`, `visudo-what-now-prompt` et `ssh-remote-editor` lisent maintenant
  la grille (`nano-body`, `nano-edit`, `nano-cursor`, `vim-body`, `vim-cmdline`) par
  `e2e/helpers/nanoScreen.ts` ; `editor-window-resize.spec.ts` et `vim-mouse.spec.ts` verifient le
  redimensionnement, la tabulation et le clic, en local et par un vrai saut SSH. `sshHop` repond
  desormais a la question de l'empreinte de la cle (`Are you sure you want to continue connecting`),
  sans quoi `ssh-remote-editor.spec.ts` n'arrivait jamais sur la machine distante.
