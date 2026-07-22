# Audit — Simulation Linux

> Périmètre : `src/bash/` (lexer/parser/interpreter/runtime), `src/network/devices/linux/` (VFS, IAM, processus, coreutils, réseau, systemd/journald, /proc), `src/network/devices/LinuxMachine.ts`, `src/terminal/` côté Linux (sessions, éditeurs, intent SSH/passwd).
> Méthode : lecture de code approfondie + vérifications empiriques ciblées (harnais Vitest jetable piloté depuis `/tmp`, appelant directement `LinuxCommandExecutor`/`LinuxPC`/`LinuxMachine`, aucun fichier du dépôt modifié). Suite de tests existante exécutée pour référence : 532 tests bash (`src/__tests__/unit/bash/`, 100 % verts) + 124 tests VFS/IAM/process/job-control échantillonnés (100 % verts). Date : 2026-07-22.

---

## Synthèse

| Sous-système | État | Sévérité max |
|---|---|---|
| Lexer/Parser bash | ✅ solide, couverture POSIX large | MINEUR |
| Interpréteur bash — expansions **non quotées** (`${arr[n]}` hors guillemets) | ❌ **régression confirmée empiriquement** | **CRITIQUE** |
| Interpréteur bash — pipelines, traps, `set -e/-u/-o pipefail` | ✅ conforme (vérifié empiriquement) | MINEUR |
| VFS (`VirtualFileSystem.ts`) — inodes, permissions, symlinks, hardlinks, ACL | ✅ solide, un seul système de fichiers (pas de VFS parallèle) | MINEUR |
| VFS — primitives absentes (xattr, inotify, quotas) | ⚠️ absentes, non bloquant pédagogiquement | MINEUR |
| Modèle de processus (`LinuxProcessManager`) | ✅ honnête sur ses limites (« not a real scheduler »), PID/PPID/signaux réels | MINEUR |
| IAM (`LinuxUserManager`) — passwd/shadow/group | ✅ source unique en mémoire, projetée sur les 3 fichiers | — |
| Dispatch des commandes — chemin **registre** (`LinuxCommandRegistry`) vs **switch géant** (`LinuxCommandExecutor`) | ❌ **duplication confirmée pour `curl`/`ifconfig`/`tcpdump`** | **CRITIQUE** |
| Dispatch — commandes `needsNetworkContext: false` (IAM/fs/system/audit) | ✅ implémentation partagée unique, registre = doc seule | — |
| Dispatch — 3ᵉ voie : rendu « stream-ui » dans `LinuxTerminalSession.ts` | ⚠️ complexité ajoutée, testée (suites `*-stream-ui.test.ts`) | MINEUR |
| coreutils — `ls` non conscient du TTY (multi-colonnes même en pipe/redirection) | ❌ **divergence confirmée empiriquement** | MAJEUR |
| /proc, /sys | ✅ fichiers générés réels (`meminfo`, `cpuinfo`, `uptime`, `mounts`, `net/arp`, `sys/kernel/*`) | MINEUR |
| systemd / journald (`LinuxServiceManager`, `LinuxLogManager`) | ✅ modèle mature, `journalctl -u`/`-f` réels | MINEUR |
| `LinuxMachine.ts` — taille et responsabilités | ⚠️ 3202 lignes, 172 méthodes, 69 imports — orchestrateur/façade, pas un monolithe métier | MINEUR |
| `LinuxCommandExecutor.ts` — taille | ⚠️ 6567 lignes, ~269 `case`, a presque doublé depuis le dernier audit (`GAP.md`, 3842 lignes le 2026-06-28) | MINEUR |
| Documentation (`CLAUDE.md`) | ⚠️ mentionne `src/terminal/filesystem.ts`/`shellUtils.ts`, **fichiers inexistants** aujourd'hui | MINEUR |

---

## Constats

### A. Interpréteur bash

**A1 — ❌ [CRITIQUE] `${arr[n]}`, `${arr[@]}`, `${arr[*]}` non quotés renvoient toujours une chaîne vide.**
Vérifié empiriquement (harnais direct sur `LinuxCommandExecutor.execute()`, hors toute couche `LinuxMachine`) :
```
arr=(a b c); echo "${arr[1]}"   →  "b"   (correct)
arr=(a b c); echo ${arr[1]}     →  ""    (FAUX — bash réel : "b")
arr=(a b); arr+=(c d); echo "${arr[@]}"  →  "a b c d"  (correct)
arr=(a b); arr+=(c d); echo ${arr[@]}    →  ""         (FAUX — bash réel : "a b c d")
```
**Cause racine identifiée** : `BashParser.parseBracedVar()` (`src/bash/parser/BashParser.ts:716-746`) construit le nœud `VariableRef` pour un mot **non quoté** en essayant successivement 4 regex (`@transform`, `:-/:=/:+/…`, `#…`, `#%/^,…`) — **aucune ne reconnaît la syntaxe d'indice `[...]`** — puis retombe sur le cas par défaut ligne 745 : `{ type: 'VariableRef', name: content, braced: true }`, c'est-à-dire `name: "arr[1]"` **avec les crochets inclus dans le nom et sans `modifier`**. Or `expandVariable()` (`src/bash/runtime/Expansion.ts:419-644`) ne déclenche la résolution d'indice de tableau (`expandArrayAccess`, ligne 598) que `if (modifier && modifier.startsWith('['))` (ligne 437) — condition jamais vraie ici. Le code retombe alors sur `env.getArray("arr[1]")` / `env.get("arr[1]")`, qui cherchent une variable **littéralement nommée** `arr[1]`, inexistante → chaîne vide.
À l'inverse, à l'intérieur de guillemets doubles, le contenu `${arr[1]}` n'est **pas** re-tokenisé par `BashParser` : il reste un fragment de texte brut (`{"type":"text","value":"${arr[1]}"}` — confirmé par dump d'AST) que `expandDoubleQuotedParts` → `expandInlineVars` (`src/bash/runtime/Expansion.ts:699-853`) réanalyse avec **son propre scanner caractère-par-caractère indépendant**, lequel gère correctement (via `content.slice(1).match(/^([A-Za-z_][A-Za-z_0-9]*)(\[([^\]]+)\])?$/)` et la logique équivalente pour l'accès direct) la séparation nom/indice.
**Impact pédagogique** : l'accès non quoté à un élément de tableau (`echo ${arr[0]}`, `for x in ${arr[@]}; do …`) est un idiome extrêmement courant dans les scripts d'administration réels et dans du code étudiant non idiomatique — il échoue silencieusement (pas d'erreur, juste une chaîne vide), ce qui est le pire des cas pédagogiques.
**Pourquoi les 532 tests bash existants ne l'ont pas détecté** : recherche exhaustive (`grep -rn 'arr\[' src/__tests__/unit/bash/`) — **toutes** les occurrences testant `${arr[…]}` en accès direct (par opposition à `${#arr[@]}`, qui a sa propre regex spéciale dans `parseBracedVar`/`expandVariable` et fonctionne non quotée) sont systématiquement entourées de guillemets doubles dans les fixtures de `bash-advanced-scripts.test.ts` et `bash-third-pass.test.ts`. Angle mort de couverture, pas façade cachée : le bug est dans le chemin réellement executé en production (vérifié via `LinuxCommandExecutor.execute()` direct, sans aucun artifice de test).
**Recommandation** : ajouter à `parseBracedVar` une branche `content.match(/^([A-Za-z_]\w*)(\[.+\])$/s)` qui pose `modifier` = le crochet complet (comme le fait déjà `content.startsWith('#')`), afin que l'unique implémentation runtime (`expandArrayAccess`) serve les deux chemins. Supprimer la réanalyse dupliquée dans `expandInlineVars` une fois l'unification faite (ou, à défaut, factoriser un unique tokenizer `${…}`→`{name, modifier}` partagé par les deux appelants).

**A2 — ✅ pipelines, `set -e`, `set -u`, `set -o pipefail`, heredoc/herestring, `2>&1`, `${var:-x}`/`${var:=x}`, arithmétique, sous-shells, fonctions : conformes.**
Vérifié empiriquement :
```
set -e; false; echo SHOULD_NOT_PRINT   → script stoppé, EXIT=1
set -u; echo $UNSET_VAR                → "bash: UNSET_VAR: unbound variable", EXIT=1   (message conforme à bash réel)
false | true; echo $?                  → 0   (sans pipefail, correct)
set -o pipefail; false | true; echo $? → 1   (avec pipefail, correct)
cat <<EOF … EOF                        → heredoc interpolé correctement
cat <<< "x"                            → herestring correcte
${X:-default} / ${Y:=assigned}         → corrects (test/assign par défaut)
ls /x 2>&1 | cat                       → stderr fusionné dans le pipe, correct
```
Cohérent avec `GAP.md §8.2` (déjà corrigé : traps `ERR`/`DEBUG`/`RETURN` câblés). `trap … INT` reste non déclenché par design documenté (Ctrl+C intercepté en amont par la couche terminal) — limite assumée, pas un bug.

**A3 — 💡 [MINEUR] pipeline multi-étapes toujours « simplifié » (capture intégrale puis ré-injection).**
Confirmé toujours présent : commentaire « simplified: pass output as arg » dans `BashInterpreter.ts`. Sans impact pour des scripts batch ; casserait un `tail -f | grep` à la sémantique de flux réelle. Déjà documenté dans `GAP.md §8.2`, situation inchangée.

### B. VFS (`VirtualFileSystem.ts`, 1236 lignes)

**B1 — ✅ inode réel, pas une table à plat.**
`INode` (`VirtualFileSystem.ts:12-37`) porte `permissions` (12 bits : setuid/setgid/sticky + rwx×3), `uid`/`gid`, `atime`/`mtime`/`ctime`, `linkCount`, ACL POSIX (`aclUsers`/`aclGroups`), et un mécanisme de fichier généré (`generator`) pour le procfs-like. `umask` appliqué à la création (`touch`/`writeFile`, ex. ligne 491 : `0o666 & ~umask`). Vérifié empiriquement : `touch /tmp/newf.txt` produit `-rw-r--r--` (umask 022 par défaut), conforme.

**B2 — ✅ liens durs réellement implémentés (pas seulement le commentaire d'en-tête).**
`createHardLink()` (`VirtualFileSystem.ts:791-805`) incrémente `linkCount` sur l'inode cible et fait pointer une nouvelle entrée de répertoire vers le **même** inode id (pas une copie) ; `unlink`/`rm` décrémentent et ne libèrent l'inode qu'à `linkCount <= 0` (ligne 679-680, 965-966). `ln`/`ln -s` (`LinuxCommandExecutor.ts:3429-3440`) distinguent bien lien dur/symbolique. Positif — à l'opposé de beaucoup de simulateurs pédagogiques qui ne modélisent qu'un pseudo-lien.

**B3 — ✅ un seul système de fichiers, pas de VFS parallèle.**
`CLAUDE.md` mentionne encore `src/terminal/filesystem.ts` et `shellUtils.ts` (« in-memory filesystem and shared shell utilities ») — **ces fichiers n'existent plus** dans l'arbre actuel (`find src/terminal -iname "*filesystem*"` : aucun résultat). Toute la couche terminal (éditeurs Vim/Nano, sessions) passe par `LinuxMachine.readFileForEditor`/`writeFileFromEditor` (`LinuxMachine.ts:2439-2489`), qui délègue directement à `executor.vfs`. **Documentation obsolète** (💡 MINEUR, cf. Constat E) mais architecture réelle saine : pas de double vérité fichier.

**B4 — ⚠️ [MINEUR] primitives Linux avancées absentes : xattr, inotify, quotas disque.**
Aucune occurrence de `xattr`/`setfattr`/`getfattr`/`inotify`/`quota` dans `src/network/devices/linux/`. À l'inverse, les bind-mounts **sont** supportés (`mount --bind`/`-B`, `--rbind`/`-R`, `LinuxCommandExecutor.ts:2839-2842`), tout comme `mount --fake` pour valider `/etc/fstab` sans monter réellement. Absence de xattr/inotify/quota jugée non bloquante pour l'usage pédagogique visé (aucun scénario réseau n'en dépend).

### C. Modèle de processus (`LinuxProcessManager.ts`, 585 lignes)

**C1 — ✅ table de processus réelle et honnête sur ses limites.**
PID/PPID/PGID/SID/UID/GID, 6 états POSIX (`R S D Z T I`), 12 signaux avec numéros POSIX corrects (`SIGNAL_NUMBERS`, lignes 48-61), `kill()`/`pkill()`/`deliverSignal()` avec distinction signaux létaux vs livrés à un handler piégé (via `trapHandlerHook`). Le commentaire d'en-tête est explicite et honnête : « Not a real scheduler — processes do not consume CPU time on their own. State transitions are driven by explicit calls. » (`LinuxProcessManager.ts:8-9`) — pas de fork/exec UNIX réel (attendu en JS single-thread), mais le modèle ne prétend pas l'inverse.

**C2 — ✅ jobs & background confirmés fonctionnels.**
124 tests VFS/process/job-control échantillonnés passent (dont `linux-job-control.test.ts`, `linux-background-jobs.test.ts`, `linux-process-model-unification.test.ts`).

### D. IAM (`LinuxUserManager.ts`, 1231 lignes)

**D1 — ✅ source de vérité unique, projetée sur passwd/shadow/group.**
Modèle en mémoire (`UserEntry`/`LinuxGroup`) projeté vers `/etc/passwd`, `/etc/shadow`, `/etc/group`, `/etc/gshadow` et les cartes subuid/subgid (`LinuxUserManager.ts:1212-1213` et suivants) — pas de fichiers VFS maintenus indépendamment de l'état en mémoire, donc pas de risque de divergence passwd↔shadow↔group de la façon que `pwck`/`grpck` sont censés détecter dans un vrai système mal administré. `useraddCommand` (registre) et `case 'useradd'` (switch) appellent **la même fonction** `cmdUseradd()` — voir Constat E.

### E. Dispatch des commandes — voir section dédiée ci-dessous.

### F. coreutils

**F1 — ❌ [MAJEUR] `ls` ne détecte jamais qu'il écrit vers un pipe/fichier — toujours multi-colonnes.**
`cmdLs`/`listDir`/`formatColumns` (`LinuxFileCommands.ts:56-260`) n'ont **aucune** notion d'isatty : le layout multi-colonnes (`formatColumns`, ligne 238, `termWidth = 80` fixe) s'applique dès que `-1` n'est pas explicitement passé, quel que soit le contexte d'exécution. Vérifié empiriquement :
```
ls /etc            → multi-colonnes (attendu, TTY)
ls /etc | cat       → multi-colonnes (FAUX — bash réel : une entrée par ligne)
ls /etc > f; cat f  → multi-colonnes (FAUX — bash réel : une entrée par ligne)
```
Un vrai `ls` (coreutils GNU) appelle `isatty(STDOUT_FILENO)` et bascule automatiquement en `-1` dès que la sortie n'est pas un terminal. C'est un des écarts les plus visibles et les plus « repérables immédiatement par un utilisateur Linux expérimenté » de tout l'audit. Impact pratique modéré (le word-splitting bash rend beaucoup de scripts `for f in $(ls)` fonctionnels par accident malgré la mise en colonnes), mais cassant pour tout pattern ligne-par-ligne (`ls | while read -r f`) et trivialement observable en démonstration.
**Recommandation** : propager un flag `isPiped`/`isRedirected` depuis `LinuxCommandExecutor`/`ShellContext` jusqu'à `cmdLs` (l'information existe déjà au niveau de l'AST — un `Pipeline`/`Redirection` est visible par l'interpréteur avant l'appel du builtin) et forcer `onePerLine = true` dans ce cas, exactement comme `-1` le fait déjà.

**F2 — ✅ `tar`/`gzip`/`zip` ont un vrai effet de bord VFS** (confirmé conforme à `GAP.md §8.4`, corrigé depuis : `coreutils/ArchiveCommands.ts`, `case 'tar'` → `cmdTar(this.archiveCtx(), args)`, `LinuxCommandExecutor.ts:4201`).

**F3 — ✅ `md5sum`/`sha1sum`/`sha256sum` déterministes** (confirmé conforme à `GAP.md §8.4`, corrigé : `@/crypto/hash`).

**F4 — ✅ `chmod`/`chown`/`stat`/`sed`/`find` présents avec de vrais moteurs dédiés** (`SedEngine`, `AwkInterpreter`+`AwkParser`, `cmdFind` avec prédicats `-mtime`/`-type`/etc. sur `VirtualFileSystem.ts:1012-1090`). Non ré-audité ligne à ligne faute de temps, mais l'architecture (un module dédié par famille d'utilitaire, pas de logique ad hoc noyée dans le switch) est saine.

**F5 — 💡 [MINEUR] `apt`/`apt-get`/`dpkg` renvoient des transcriptions figées, sans état de paquets installés persistant** (confirmé identique à `GAP.md §8.4`, non corrigé — jugé à juste titre secondaire pour un labo réseau).

### G. /proc, /sys, systemd/journald

**G1 — ✅ pseudo-fichiers procfs réellement générés (pas des littéraux figés).**
`/proc/cpuinfo`, `/proc/meminfo`, `/proc/uptime` délèguent à `this.hardware.cpu.toProcCpuinfo()`/`this.hardware.memory.toProcMeminfo()` (`LinuxCommandExecutor.ts:862-868`) — cohérents avec `free`. `/proc/mounts`, `/proc/self/mountinfo` délèguent à `MountTable`. `/proc/net/arp` reflète la table ARP réelle du device. `/proc/self` est un symlink vers le PID du shell courant (ligne 778-779). `/proc/sys/kernel/{ostype,osrelease,version,hostname}` générés depuis l'identité machine réelle.
**Limite** : pas de répertoires `/proc/<pid>/{cmdline,status,fd,...}` par processus détectés dans le code — `ps`/`top` interrogent directement `LinuxProcessManager` plutôt que de lire un procfs par PID matérialisé. Écart mineur : le résultat visible (`ps`, `top`) est correct, seule la matérialisation `/proc/<pid>/*` manque pour un utilisateur qui voudrait `cat /proc/1234/status` directement.

**G2 — ✅ systemd/journald matures.**
`LinuxServiceManager.ts` (1429 lignes) et `LinuxLogManager.ts` (971 lignes) implémentent des unités de service avec états réels et un vrai moteur `journalctl` (`-u`, `-f` live via abonnement, `--since`/`--until`), cohérent avec `GAP.md §6.4` qui qualifiait déjà syslog de « référence MVC » du projet.

### H. `LinuxMachine.ts` — orchestrateur

**H1 — ⚠️ [MINEUR] taille conséquente mais rôle de façade assumé.**
3202 lignes, 172 méthodes, 69 imports. Contrairement à un « god object » qui réimplémenterait la logique métier, la lecture du fichier montre un rôle de **façade/pont** : routage bash↔réseau (`executeCommand`/`tryNetworkCommand`), hooks vers `LinuxCommandExecutor` (`_registryCommandHook`), pass-through éditeurs, hooks Oracle FS. La complexité vient du nombre de **rôles différents à ponter** (registre de commandes, bash, éditeurs, Oracle, sessions), pas d'une logique métier dupliquée sur place. À surveiller si de nouveaux rôles viennent s'y ajouter — c'est le point de couplage le plus dense du sous-système Linux.

### I. Terminal côté Linux

**I1 — ⚠️ [MINEUR] `LinuxTerminalSession.ts` (4126 lignes) constitue une 3ᵉ voie de dispatch pour les commandes « live/streaming ».**
Ce fichier importe directement des parseurs/formatteurs bas niveau (`parsePingArgs`, `parseTracerouteArgs`, `parseMtrArgs`, `parseVmstatArgs`, `parseIostatArgs`, `parseInvocation`/`compileFilter`/`formatFrame` pour `tcpdump`, `parseWatchArgs`, `parseIpMonitorSpec`, …) pour piloter un rendu incrémental (barres de progression, capture en direct) que le modèle synchrone `LinuxCommand.run(): string` ne peut pas exprimer. C'est un **3ᵉ chemin d'exécution**, distinct du registre `LinuxCommand` et du switch `LinuxCommandExecutor`, réservé aux commandes « longue durée / streaming » (`ping` continu, `tcpdump` interactif, `watch`, `vmstat`/`iostat`/`mpstat`/`pidstat`, `journalctl -f`, `ip monitor`). Risque théoriquement identique au double dispatch (comportement différent selon que la commande est tapée au prompt vs dans un script), mais **atténué** ici : le fichier réutilise les mêmes fonctions de formatage partagées que le reste du système (`LinuxFormatHelpers`) plutôt que de dupliquer la logique métier, et une famille de tests dédiée existe (`linux-ping-stream-ui.test.ts`, `linux-tcpdump-stream-ui.test.ts`, `linux-vmstat-stream-ui.test.ts`, `linux-watch-stream-ui.test.ts`, `linux-mpstat-stream-ui.test.ts`, `linux-pidstat-stream-ui.test.ts`, `linux-iostat-stream-ui.test.ts`, `linux-netstat-stream-ui.test.ts`, `linux-free-stream-ui.test.ts`, `linux-dmesg-stream-ui.test.ts`, `linux-ip-monitor-stream-ui.test.ts`, `linux-top-journalctl-stream-ui.test.ts` — 12 suites). Non ré-audité en profondeur faute de temps ; recommandé comme prochaine cible d'investigation du double-dispatch.

**I2 — 💡 non ré-audités faute de temps** : `src/components/editors/` (VimEngine.ts 2265 lignes, NanoEngine.ts 1253 lignes), `src/terminal/intent/` (flux interactifs SSH/passwd via `ShellActionRegistry`/`InputPrompt`). Existence et volumétrie confirmées, contenu non vérifié empiriquement.

### J. Documentation

**J1 — 💡 [MINEUR] `CLAUDE.md` obsolète sur `src/terminal/`.**
`CLAUDE.md` (racine du dépôt) liste `filesystem.ts`/`shellUtils.ts` comme faisant partie de `src/terminal/` — ces fichiers sont absents de l'arbre actuel (probablement supprimés lors de la convergence vers un VFS unique, cf. Constat B3 — un changement plutôt positif). `CLAUDE.md` ne mentionne pas non plus `src/terminal/async/` ni `src/terminal/completion/`, présents aujourd'hui. Le comportement documenté dans les commentaires internes du code (`LinuxCommand.ts`, `LinuxCommandRegistry.ts`) référence un fichier `linux_gap.md` introuvable dans le dépôt (probablement renommé en `GAP.md` sans mise à jour des ~24 références internes au code — `grep -rln "linux_gap" src` → 24 fichiers).

---

## Le problème du double dispatch : analyse détaillée

### Architecture en présence

Le sous-système Linux compte **quatre points d'entrée** pour exécuter une commande :

1. **`LinuxCommandRegistry`** (`src/network/devices/linux/commands/`, 86 commandes déclarées à travers ~90 fichiers) — chaque commande est un objet `LinuxCommand` avec `run()`/`runWithStatus()`, et un flag `needsNetworkContext`.
2. **Le switch géant de `LinuxCommandExecutor.ts`** (6567 lignes, ~269 `case`) — l'interpréteur bash (`BashInterpreter`) y délègue chaque commande simple via `dispatch()`.
3. **`LinuxMachine.tryNetworkCommand()`** (`LinuxMachine.ts:1897-1973`) — court-circuite le bash pour une invocation *simple* (sans `;`, `|`, `&&`, `` ` ``, `$(`, `<`, `>`) d'une commande `needsNetworkContext: true`.
4. **`LinuxTerminalSession.ts`** — 3ᵉ voie pour les commandes à rendu incrémental (§I1), hors périmètre de cette section.

Le routage entre (2) et (3) est décidé par `LinuxMachine.executeCommand()` (`LinuxMachine.ts:1724-1758`) :

```
composite syntax (;|&&()`` $( < >) ?
   oui → executor.executeAsync(line)     // tout passe par bash → switch (2)
   non → tryNetworkCommand(line)         // court-circuite bash → registre (3), si needsNetworkContext
```

Pour boucler la boucle, `LinuxCommandExecutor`'s `default:` (fin du switch, `LinuxCommandExecutor.ts:4536-4558`) appelle `this._registryCommandHook?.(cmd, args)` — un hook injecté par `LinuxMachine` qui retombe sur le registre **uniquement pour les commandes qui n'ont pas de `case` explicite dans le switch**.

### Le point de rupture

**Si une commande a À LA FOIS `needsNetworkContext: true` dans le registre ET un `case` explicite dans le switch, ce `case` gagne systématiquement dès qu'il y a la moindre syntaxe composite** — le `default:` (et donc `_registryCommandHook`) n'est jamais atteint pour cette commande. Recensement exhaustif (comparaison `grep -oP "case '\K[^']+"` sur le switch vs `needsNetworkContext: true` sur le registre) : **exactement 3 commandes sont dans ce cas — `curl`, `ifconfig`, `tcpdump`** (`ping`, `traceroute`, `arp`, `route`, `ss`, `nc`, `iptables`, `date`, `uname`, `hostname`, `dig`, `nslookup`, etc. — toutes les autres commandes `needsNetworkContext: true` — n'ont **aucun** `case` dans le switch et retombent donc proprement sur le registre via `default:`, sans divergence).

### Preuves empiriques (les 3 commandes concernées)

**`curl`** — le registre (`commands/net/Curl.ts:25-94`) fait un vrai dial HTTP/HTTPS à travers la pile TCP simulée (`ctx.net.resolveHostnameSync`, `HttpsClientSession`, vérification de certificat) ; le switch (`LinuxCommandExecutor.ts:4120`, `case 'curl': return { output: cmdCurl(args), exitCode: 0 }`) appelle `cmdCurl()` (`LinuxNetCommands.ts:766-800`), qui ne connaît que `localhost`/`127.0.0.1` en dur et renvoie sinon systématiquement `curl: (6) Could not resolve host: …`, **sans jamais consulter la topologie réelle**. Vérifié :
```
curl http://10.0.0.99/            (tapé seul)        → "curl: (7) Failed to connect … Connection refused"   (réel, topologie consultée)
curl http://10.0.0.99/ | cat      (dans un pipe)      → "curl: (7) Failed to connect … Connection refused"   (réel — le pont async gère aussi ce cas)
echo "curl http://10.0.0.99/" > s.sh; bash s.sh        → "curl: (6) Could not resolve host: 10.0.0.99"       (FAUX — legacy, ignore la topologie)
```
Le même appel produit un message d'erreur **différent et incorrect** selon qu'il est exécuté depuis un script — cas d'usage réaliste et fréquent (scripts de déploiement, healthchecks).

**`ifconfig`** — le registre (`commands/net/Ifconfig.ts:46-115`) supporte l'assignation d'adresse (`ifconfig eth0 <ip> netmask <mask>`, `up`/`down`, via `ctx.net.configureInterface`) ; le switch (`LinuxCommandExecutor.ts:4118`, `cmdIfconfig(args, this.ipNetworkCtx)` → `LinuxNetCommands.ts:158-174`) est **strictement en lecture seule** — il ignore silencieusement tout argument au-delà du nom d'interface et renvoie l'état courant sans erreur ni avertissement. Vérifié :
```
ifconfig eth0 192.168.50.5 netmask 255.255.255.0            (tapé seul) → interface reconfigurée (inet 192.168.50.5 présent)
ifconfig eth0 192.168.60.5 netmask 255.255.255.0 && echo done (chaîné)  → interface reconfigurée (le pont async gère ce cas aussi)
echo "ifconfig eth0 192.168.70.5 netmask 255.255.255.0" > s.sh; bash s.sh → AUCUNE erreur, exit 0, mais l'interface reste NON configurée
                                                                             (pas de ligne "inet" du tout dans le ifconfig de contrôle après coup)
```
C'est le scénario le plus dommageable des trois : un script de provisioning réseau « réussit » silencieusement sans configurer quoi que ce soit — aucun signal d'erreur pour l'utilisateur.

**`tcpdump`** — divergence plus cosmétique mais réelle : le registre (`commands/net/Tcpdump.ts:35-43`) utilise le moteur de capture asynchrone `runTcpdump`/`TcpdumpRunner` ; le switch (`LinuxCommandExecutor.ts:4279-4294`) utilise l'ancien `cmdTcpdump(args, this.captureLog, fsAdapter)`. Vérifié : le texte d'en-tête diverge — `"capture size 262144 bytes"` (voie registre, tapé seul) contre `"snapshot length 262144 bytes"` (voie switch, script) — ce dernier étant en fait le libellé **conforme** au vrai `tcpdump` (« snapshot length »), donc c'est ici la voie *registre* qui a la formulation incorrecte. Preuve supplémentaire que les deux implémentations ont dérivé indépendamment dans les deux sens.

### Pourquoi ce n'est pas (que) un problème théorique

Le même mécanisme de duplication existe **à l'intérieur même du moteur bash** (Constat A1) entre `BashParser.parseBracedVar` (chemin non quoté) et `expandInlineVars` (chemin quoté, à l'intérieur de `expandDoubleQuotedParts`) : deux implémentations indépendantes de la grammaire `${nom[indice]}`, l'une gérant l'indiçage de tableau, l'autre pas. C'est le même anti-pattern architectural — deux moteurs qui devraient être un seul, maintenus séparément, qui divergent silencieusement — reproduit à un niveau plus profond de la pile. Le risque n'est donc pas cantonné à la couche `Linux*Command` : c'est un mode de défaillance récurrent de la base de code partout où « la même syntaxe » est reconnue par deux analyseurs distincts selon le contexte d'appel (quoté/non quoté, tapé/scripté, avec/sans composition shell).

### Pourquoi les 27 commandes « IAM/fs/system/audit » en apparence dupliquées ne sont PAS à risque

Recensement initial : 27 noms de commandes présents à la fois dans le registre et dans le switch (`adduser`, `useradd`, `userdel`, `usermod`, `passwd`, `groupadd`, `chown`, `chgrp`, `mount`, `umount`, `ufw`, `auditctl`, …). Vérification systématique : **toutes** ont `needsNetworkContext: false` dans le registre. Le commentaire de `LinuxCommand.ts:50-60` documente explicitement cette intention : pour ces commandes, l'entrée du registre sert **uniquement** à la documentation (`--help`/`man`) et à l'auto-complétion — l'exécution passe toujours par le switch, qui appelle **la même fonction partagée** (ex. `useraddCommand.run()` et `case 'useradd'` appellent tous deux `cmdUseradd()` — vérifié ligne à ligne pour `useradd`). Aucune divergence de comportement possible ici : c'est de la duplication de *déclaration*, pas de *logique*, et elle est intentionnelle et documentée.

### Verdict

Le risque de double dispatch est **réel mais précisément circonscrit** : 3 commandes réseau (`curl`, `ifconfig`, `tcpdump`) sur ~355 points d'entrée recensés (269 `case` + 86 commandes registre), plus un bug de portée équivalente mais plus grave dans le moteur d'expansion bash lui-même. Le pattern architectural qui les cause est identifiable et se résume à une règle simple : **toute commande qui gagne `needsNetworkContext: true` dans le registre doit voir son `case` supprimé du switch** (au profit de `_registryCommandHook`, qui existe déjà et fonctionne correctement pour les ~50 autres commandes réseau). C'est une dette de migration inachevée, pas un défaut de conception — l'architecture cible (registre = seule source de vérité pour les commandes réseau) est la bonne et est déjà appliquée à la grande majorité des commandes.

---

## Top 10 des actions recommandées

1. **[CRITIQUE]** Corriger `BashParser.parseBracedVar` (`src/bash/parser/BashParser.ts:716-746`) pour reconnaître la syntaxe d'indice `[...]` et poser `modifier` en conséquence, afin que `${arr[n]}`/`${arr[@]}`/`${arr[*]}` non quotés fonctionnent (actuellement toujours vides). Ajouter des tests non quotés miroir de chaque test quoté existant dans `bash-advanced-scripts.test.ts`/`bash-third-pass.test.ts`.
2. **[CRITIQUE]** Supprimer les `case 'curl'`, `case 'ifconfig'`, `case 'tcpdump'` de `LinuxCommandExecutor.ts` (lignes 4118, 4120, 4279-4294) pour laisser `_registryCommandHook` router systématiquement vers l'implémentation du registre — élimine la divergence tapé/scripté pour ces 3 commandes en une suppression de code, pas un ajout.
3. **[MAJEUR]** Rendre `ls` conscient du contexte pipe/redirection (`LinuxFileCommands.ts:56-260`) : propager un signal « sortie non-TTY » depuis l'interpréteur (déjà connu de l'AST au moment de l'appel du builtin) jusqu'à `cmdLs`, et forcer `onePerLine` dans ce cas.
4. **[MAJEUR]** Une fois (1) et (2) traités, auditer systématiquement s'il existe d'autres paires quoté/non-quoté ou tapé/scripté divergentes dans `Expansion.ts` — envisager d'unifier `expandInlineVars` (scanner ad hoc pour le texte entre guillemets) sur le même tokenizer que `BashParser`/`expandVariable`, pour supprimer la classe de bug entière plutôt que ses symptômes un par un.
5. **[MINEUR]** Mettre à jour `CLAUDE.md` : retirer la mention de `src/terminal/filesystem.ts`/`shellUtils.ts` (fichiers supprimés), documenter `src/terminal/async/` et `src/terminal/completion/` (présents, non mentionnés). Faire le ménage des ~24 références internes à `linux_gap.md` (fichier introuvable, probablement renommé `GAP.md`).
6. **[MINEUR]** `LinuxCommandExecutor.ts` a doublé de volume depuis le dernier audit (`GAP.md`, 3842 → 6567 lignes en moins d'un mois) sans réduction du nombre de `case` proportionnelle à l'effort d'extraction déjà amorcé (modules `coreutils/`, `iam/`, `jobs/`, `nss/`, `audit/`) — poursuivre l'extraction pour les blocs restants (`ipsec`/`ssh-agent`/ACL) avant que le fichier ne redevienne le goulot d'étranglement de lisibilité qu'il était.
7. **[MINEUR]** Auditer en profondeur la 3ᵉ voie de dispatch dans `LinuxTerminalSession.ts` (4126 lignes, §I1) — vérifier notamment que `tcpdump`/`ping`/`watch` tapés en direct dans le terminal produisent des formats identiques à ceux obtenus via un script (`bash script.sh`) pour les mêmes commandes, en particulier après correction de l'action 2 (le format `tcpdump` pourrait re-diverger différemment une fois le switch supprimé).
8. **[MINEUR]** Envisager de matérialiser `/proc/<pid>/{cmdline,status}` à partir de `LinuxProcessManager` (actuellement `ps`/`top` interrogent directement la table de processus sans procfs par PID) — cohérence pédagogique pour les scripts qui font `cat /proc/$$/status`.
9. **[MINEUR]** Documenter explicitement (README de `src/bash/` ou commentaire de tête de `BashInterpreter.ts`) les limites assumées déjà identifiées et correctement gérées : pipeline « simplifié » (pas de vrai flux), `trap INT` non câblé au niveau interpréteur — pour distinguer clairement dette documentée de dette silencieuse.
10. **[MINEUR]** Étendre la couverture de tests bash pour les formes **non quotées** de toutes les expansions à risque (tableaux associatifs `${map[k]}` non quoté à vérifier également — même cause racine que le Constat A1, non testé empiriquement faute de temps) — un test miroir quoté/non-quoté systématique aurait intercepté le Constat A1 avant qu'il n'atteigne cet état.
