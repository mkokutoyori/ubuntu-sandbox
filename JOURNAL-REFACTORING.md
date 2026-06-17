# Journal de bord — Refactoring & corrections de cohérence

Ce journal documente les défaillances, limites et incohérences corrigées dans
le simulateur, avec un focus sur la couche **Oracle** et sa cohérence avec les
autres couches du projet (réseau, processus, accès, filesystem).

Méthode : améliorations **structurelles** et profondes uniquement (pas de
patchs cosmétiques), priorité à l'enhancement de l'existant, recherche
systématique des doublons avant toute création, et un test de
non-régression + un test de validation pour chaque correctif.

---

## 2026-06-17

### #1 — Mort d'un processus de fond Oracle ⇄ état de l'instance (cohérence process)

**Couches concernées :** Oracle (instance) ↔ OS (table des processus / signaux).

**Symptôme / défaillance constatée.**
Tuer un processus de fond Oracle depuis le shell de l'hôte
(`kill -9` / `pkill` d'un `ora_pmon`, `ora_smon`, `ora_lgwr`, …) le retirait
de `ps` mais laissait l'instance dans l'état `OPEN`. Les vues dynamiques
(V$PROCESS / V$BGPROCESS / V$SESSION) continuaient donc à lister un processus
mort, et l'instance « survivait » à la mort de PMON — ce qui est impossible
sur un vrai Oracle.

Le handler `linux.process.signalled` de `OracleFilesystemSync` ne traitait
que les *dedicated server processes* (`getServerProcessByPid`) ; la mort d'un
processus de fond n'avait aucun effet côté moteur.

**Comportement réel d'Oracle reproduit.**
- Mort d'un processus **critique** (PMON, SMON, DBWn, LGWR, CKPT) → l'instance
  termine immédiatement, équivalent à un `SHUTDOWN ABORT` ; comme aucun
  checkpoint n'est pris, le prochain démarrage effectue une *instance
  recovery*. Bannière d'alert log reproduite :
  `<PROC> (ospid: N): terminated with error` /
  `PMON (ospid: N): terminating the instance due to error <ORA-00469..474>` /
  `Instance terminated by PMON, pid = N`.
- Mort d'un processus **non critique** (RECO, MMON, MMNL, ARCn) → PMON le
  redémarre de façon transparente sous un nouveau pid, l'instance reste
  `OPEN`. Alert log : `Restarting dead background process <PROC>`.

**Implémentation.**
- `OracleInstance` : ajout de `getBackgroundProcessByPid()` et
  `handleBackgroundProcessDeath()` (classification critique / non critique via
  `CRITICAL_BG_PROCESSES` + `BG_TERMINATION_ERROR`), plus factorisation de
  l'allocation de pid dans un helper `nextPid()` (3 sites dédupliqués).
- `OracleFilesystemSync` : le handler `linux.process.signalled` route
  désormais la mort d'un processus de fond vers `handleBackgroundProcessDeath`
  (après avoir d'abord tenté la voie *server process* existante).

**Bug de fond découvert et corrigé à la source (cohérence des signaux OS).**
`LinuxProcessManager.kill()` publiait toujours `linux.process.signalled`, y
compris lorsque l'overlay interne de la table des processus se nettoyait
(`unregisterProcess` / `clearSystemProcesses` via `processMgr.kill(SIGKILL)`).
Le nettoyage interne du simulateur était donc **indiscernable** d'un vrai
`kill` utilisateur — ce qui, avec le nouveau comportement, provoquait des
faux positifs (crash de l'instance pendant un shutdown normal) et une
récursion lors du redémarrage d'un processus.

Correctif structurel : `kill(pid, signal, { silent })` ; les reaps internes
de l'overlay (`unregisterProcess`, `clearSystemProcesses`) passent `silent:
true` et n'émettent plus de signal. Un nettoyage interne n'est pas un signal
délivré. (Effet de bord positif : plus de fausses lignes kernel
« received signal » loggées par `PortActivityLogProjection` lors des reaps
internes.)

**Anti-doublon.** Vérifié que la projection systemd existante
(`OracleSystemdSync` + `ServicePortProjection`) gère déjà le `tnslsnr` comme
processus OS et le port 1521 — une première piste (enregistrer `tnslsnr` via
`OracleFilesystemSync`) a été **abandonnée** car elle aurait dupliqué ce
mécanisme. Seule la lacune réelle (processus de fond) a été traitée.

**Tests.**
- Nouveau : `src/__tests__/unit/database/oracle-background-process-kill.test.ts`
  (crash sur PMON/SMON/LGWR, redémarrage de MMON, signal non terminant,
  redémarrage de l'instance après crash).
- Non-régression : suites `database/` + `network-v2/` complètes
  → **10154 passed**, 0 régression. Lint propre.

**Fichiers touchés :**
`src/database/oracle/OracleInstance.ts`,
`src/adapters/OracleFilesystemSync.ts`,
`src/network/devices/linux/LinuxProcessManager.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/database/oracle-background-process-kill.test.ts`.
