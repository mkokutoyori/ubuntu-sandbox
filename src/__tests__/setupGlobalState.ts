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

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  __setDefaultEventBus(null);
  __setDefaultScheduler(null);
});
