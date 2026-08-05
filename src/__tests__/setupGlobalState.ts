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
import { __resetFaultProjection } from '@/network/faults/FaultProjection';
import { __assumeCarrierOnUncabledPorts } from '@/network/devices/inspection/InterfaceStatusView';

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
  // Un port jamais câblé n'a pas de porteuse, donc pas de route : c'est le
  // comportement de production. Une fixture bâtie sans plan de câblage
  // appelle `__assumeCarrierOnUncabledPorts(true)` pour s'en exempter, et
  // cette remise à zéro l'empêche de déborder sur le fichier suivant.
  __assumeCarrierOnUncabledPorts(false);
});
