# Journal de bord — Refactoring & cohérence inter-couches (focus Oracle)

Ce journal documente, increment par increment, les défaillances / limites
structurelles corrigées dans le simulateur. Objectif : améliorations
profondes (pas de patchs cosmétiques), en privilégiant l'enrichissement de
l'existant et l'élimination des duplications, avec une attention particulière
à la **cohérence des fonctionnalités Oracle avec les autres couches**
(réseau, processus, accès/utilisateurs, filesystem).

## Méthode

- Exploration à l'échelle du projet avant toute modification.
- Réutilisation des patterns existants (adaptateurs bus, `getTcpStack()`,
  `SocketTable`, services systemd…) plutôt que création from-scratch.
- Un incrément = une amélioration cohérente, testée, buildée, puis poussée.

## Audit initial (synthèse)

Trois audits ciblés ont été menés (réseau, OS/process/fs, structure).
Principales défaillances identifiées :

1. **[RÉSEAU — CRITIQUE]** Les connexions Oracle court-circuitent
   totalement la pile réseau. Le listener TNS n'est qu'un booléen
   (`OracleInstance._listenerState`) : aucun port 1521 n'est réellement
   ouvert sur l'équipement. `netstat`/`ss` n'affichaient le listener que
   via une ligne **codée en dur** dans le *fallback* sans device
   (`LinuxNetCommands.ts`). Sur un vrai `LinuxServer`, le listener
   n'apparaissait donc nulle part. → cohérence réseau cassée.
2. **[ACCÈS/OS — CRITIQUE]** Aucun utilisateur OS `oracle` ni groupe `dba`
   n'existe réellement sur l'hôte Linux ; `DEFAULT_OS_CONTEXT` code en dur
   `isDbaGroup: true` → le contrôle `/ AS SYSDBA` réussit toujours.
3. **[PROCESS — CRITIQUE]** Les process d'arrière-plan Oracle sont
   enregistrés avec un UID codé en dur (1/daemon) au lieu de l'UID oracle.
4. **[FILESYSTEM] ** `ORACLE_HOME` / `ORACLE_SID` / `ORACLE_BASE` ne sont pas
   exportés au shell ; pas de `/etc/profile.d/oracle.sh`.
5. **[SYSTEMD]** Les unités `oracle-*.service` référencent des `ExecStart`
   (`dbstart`, `dbshut`, `lsnrctl`) qui n'existent pas sur le VFS.
6. **[STRUCTURE]** `OracleExecutor.ts` (4280 lignes) = god class ; codes
   d'erreur `ORA-xxxxx` dupliqués inline alors qu'un registre `ORACLE_ERRORS`
   existe et n'est pas utilisé ; couche `engine/` sous-exploitée.

Roadmap d'implémentation (un push par item) :

- [x] 1. Listener TNS : binding TCP réel (socket 1521) piloté par l'état du listener.
- [x] 2. Provisioning utilisateur OS `oracle` + groupe `dba` sur l'hôte.
- [ ] 3. Process d'arrière-plan Oracle sous l'UID oracle réel.
- [ ] 4. Variables d'environnement ORACLE_* exportées (`/etc/profile.d`).
- [ ] 5. Stubs `dbstart`/`dbshut`/`lsnrctl` pour des unités systemd valides.
- [ ] 6. Centralisation des codes d'erreur ORA- (DRY).
- [ ] 7. Décomposition du god class `OracleExecutor` (strategy/handlers).

---

## Incrément 2 — Identité OS Oracle (`oracle`:`oinstall`+`dba`) réelle

### Défaillance corrigée

L'utilisateur `oracle` et le groupe `dba` n'existaient **pas** sur l'hôte :
ce n'étaient que des chaînes codées en dur (`DEFAULT_OS_CONTEXT`,
`OracleFilesystemSync`, unités systemd `User=oracle`). Conséquences :

- Les unités systemd `oracle-*.service` référençaient `User=oracle` — un
  utilisateur inexistant dans `/etc/passwd`.
- Le contrôle `/ AS SYSDBA` reposait sur un `isDbaGroup` codé en dur,
  jamais adossé à une vraie appartenance au groupe `dba`.
- Les process d'arrière-plan / datafiles « appartenaient » à un label
  `oracle` sans entrée `/etc/passwd` correspondante.

### Correctif (structurel, réutilisable)

- Nouvelle capacité device **`LinuxMachine.installServiceAccount(spec)`** :
  provisionne idempotemment groupe(s) + utilisateur dédié via le vrai
  `LinuxUserManager` (`groupadd`/`useradd`/`usermod`). Générique (réutilisable
  pour tout démon), adossée à `/etc/passwd` + `/etc/group`.
- `getOracleDatabase` provisionne désormais l'identité Oracle 19c standard
  avant le boot de l'instance : utilisateur `oracle` (uid 54321, home
  `ORACLE_BASE`, shell `/bin/bash`), groupe primaire `oinstall` (gid 54321),
  groupe supplémentaire `dba` (gid 54322) — exactement comme un installeur
  Oracle. Fait via une capacité duck-typée (no-op sur équipement non-Linux).

### Tests

- Nouveau `oracle-os-account.test.ts` (6 cas : absence avant install,
  `getent passwd/group`, appartenance `id oracle`, idempotence, ancrage de
  `User=oracle`).
- Database (2636) + suites IAM/utilisateurs (332) : **OK**, 0 régression.

---

## Incrément 1 — Listener TNS : socket TCP réel piloté par le cycle de vie

### Défaillance corrigée

Le port du listener Oracle (tcp/1521) n'était **pas** cohérent avec l'état
réel du listener :

- `OracleInstance` modélise le listener par un simple booléen
  (`listenerStatus`, **stopped par défaut** — contrat encodé dans
  `oracle-phase4.test.ts`, `oracle-systemd-integration.test.ts`,
  `oracle-dbms-filesystem-coherence.test.ts`).
- Mais côté OS, le socket 1521 était **toujours** présent, via deux
  sources de fakery indépendantes du listener :
  1. `LinuxMachine.initDefaultSockets` liait 1521/tnslsnr en dur pour tout
     profil serveur, dès le boot.
  2. Le service `oracle-ohasd` (`SERVICE_LISTENERS`) projetait en
     permanence un socket 1521 avec `processName: 'tnslsnr'` — alors que
     **ohasd ≠ tnslsnr** (ohasd est le démon Grid/HA, pas le listener).
  3. Les fallbacks device-less de `netstat`/`ss` réinjectaient une ligne
     1521 codée en dur.

Résultat : `netstat`/`ss` affichaient 1521 LISTEN même listener arrêté
(et `lsnrctl stop` ne libérait jamais le port), en contradiction avec le
process `ps` (déjà piloté par l'état via `syncOracleProcessesToDevice`) et
l'unité systemd `oracle-listener-<SID>`.

### Correctif (structurel, sans duplication)

- Nouvel adaptateur **`src/adapters/OracleListenerSync.ts`** (même pattern
  que `OracleSystemdSync`/`OracleFilesystemSync`) : pur abonné du bus, il
  ouvre/ferme un **vrai** socket d'écoute sur l'hôte
  (`getTcpStack().listen()` + `getSocketTable().bind()`, la surface utilisée
  par tous les démons TCP comme sshd) en lockstep avec
  `oracle.listener.event`. Idempotent (pas d'EADDRINUSE), port extrait du
  descripteur TNS. Câblé dans `database.ts` + nettoyé dans
  `removeOracleDatabase`/`resetAllOracleInstances`.
- Suppression des trois sources de fakery : bind boot-time dans
  `LinuxMachine`, projection 1521 de `oracle-ohasd` (réétiqueté en démon HA
  `ohasd.bin` sans socket), lignes 1521 codées en dur des fallbacks
  `netstat`/`ss`.
- Le socket 1521 a désormais **une seule source de vérité** : le cycle de
  vie réel du listener. Cohérence totale socket ⟺ `ps` ⟺ unité systemd ⟺
  `V$LISTENER` ⟺ `OracleInstance.listenerStatus`.

### Tests

- Nouveau `oracle-listener-network.test.ts` (6 cas : pas de bind par
  défaut, bind tnslsnr:1521 au start, libération au stop, idempotence,
  visibilité `netstat`/`ss`).
- Mise à jour des tests qui encodaient l'ancien comportement incohérent
  (`socket-table.test.ts`, `linux-commands-and-oracle-tools.test.ts`).
- Suite complète réseau + database : **9556 tests OK**, 0 régression.
  Lint : aucune nouvelle erreur. Build : OK.

---
</content>
</invoke>
