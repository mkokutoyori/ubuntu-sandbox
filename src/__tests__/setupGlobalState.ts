// Automatic backstop for the mutable module-level singletons every test
// file otherwise has to reset by hand (EquipmentRegistry, the default
// EventBus/Scheduler, MAC/ID counters, Logger). A test file that forgets
// one of these — or resets incompletely — used to pollute whichever test
// ran next in the same file (rapport 08, item #51: 834 files already do
// this reset manually; this makes the safety net unconditional instead of
// opt-in). Deliberately scoped to the handful of globals that are shared
// by virtually every test regardless of subsystem — subsystem-specific
// singletons (Oracle instances, PKI CA registry, AD forest registry, …)
// stay the responsibility of the tests that actually use them.
import { beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { __setDefaultEventBus } from '@/events/EventBus';
import { __setDefaultScheduler } from '@/events/Scheduler';
import { resetFaultRegistry } from '@/network/faults/FaultRegistry';
import { resetForestRegistry } from '@/network/devices/windows/server/ad/forest/Forest';
import { __resetFaultProjection } from '@/network/faults/FaultProjection';
import {
  __assumeCarrierOnUncabledPorts, __setInterfacesBootShutdown, __setLegacyRouterPortCount,
} from '@/network/devices/inspection/InterfaceStatusView';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  __setDefaultEventBus(null);
  __setDefaultScheduler(null);
  // The fault registry is a topology-wide singleton like the ones above:
  // a leaked incident would make the next test see a device it never
  // broke (docs/PRD-Pannes.md §6.1). Its projection is dropped too, since
  // it holds subscriptions on the bus that was just discarded.
  __resetFaultProjection();
  resetFaultRegistry();
  // La forêt AD est un registre de MODULE (`domainToForest`), donc
  // partagé par tous les tests d'un même worker. CLAUDE.md le range
  // parmi les singletons « à la charge de chaque fichier de test » ;
  // la mesure dit que cette règle ne tient pas — **54 fichiers**
  // construisent une forêt et AUCUN ne la remet à zéro, si bien qu'un
  // second `Install-ADDSForest` sur `mandeng.lan` retrouve la forêt du
  // test précédent et ses détenteurs de rôles FSMO périmés.
  //
  // C'est la cause d'un rouge intermittent qui a coûté une fausse
  // attribution : `scenario-ad-replication-topology` échouait sur
  // `Get-ADDomain | Select PDCEmulator` sans que rien d'AD ait changé.
  //
  // L'objection de CLAUDE.md contre ce genre d'ajout — le coût d'import
  // pour tous les fichiers — ne s'applique pas : `Forest.ts` n'a qu'un
  // `import type`, donc aucune dépendance à l'exécution.
  resetForestRegistry();
  // Un port jamais câblé n'a pas de porteuse, donc pas de route : c'est le
  // comportement de production. Une fixture bâtie sans plan de câblage
  // appelle `__assumeCarrierOnUncabledPorts(true)` pour s'en exempter, et
  // cette remise à zéro l'empêche de déborder sur le fichier suivant.
  __assumeCarrierOnUncabledPorts(false);
  // Une interface physique de routeur Cisco démarre `shutdown` sur IOS,
  // et c'est le défaut de production. Les suites antérieures à
  // l'itération 3 supposent des interfaces actives au boot : on leur rend
  // ce défaut ici plutôt que de migrer 1500 fichiers d'un coup. Une suite
  // qui veut la fidélité appelle `__setInterfacesBootShutdown(true)`.
  __setInterfacesBootShutdown(false);
  // Un ISR 2911 porte trois interfaces, et c'est ce que la production
  // construit. Les suites antérieures en supposent quatre ; on le leur
  // rend ici, une suite de fidélité appelant
  // `__setLegacyRouterPortCount(null)`.
  __setLegacyRouterPortCount(4);
});
