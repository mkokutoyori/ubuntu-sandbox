/**
 * Public surface of the reactive event system.
 *
 * See `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` for the full architectural
 * rationale. The four primitives exported below — `EventBus`, `Scheduler`,
 * `Signal`, `waitForEvent` — are the foundation on which subsequent
 * refactor phases (Logger adapter, Port/Cable events, scheduler injection
 * in protocol engines, projections + UI hooks, …) are built.
 */

export type {
  IEventBus,
  Handler,
  Unsubscribe as BusUnsubscribe,
} from './EventBus';
export {
  EventBus,
  getDefaultEventBus,
  __setDefaultEventBus,
} from './EventBus';

export type { IScheduler, TimerHandle } from './Scheduler';
export {
  RealTimeScheduler,
  VirtualTimeScheduler,
  getDefaultScheduler,
  __setDefaultScheduler,
} from './Scheduler';

export { TimerSet } from './TimerSet';

export type { Signal, Unsubscribe as SignalUnsubscribe } from './Signal';
export { WritableSignal, derived } from './Signal';

export type { WaitForEventOptions } from './waitForEvent';
export {
  waitForEvent,
  WaitForEventTimeoutError,
  WaitForEventAbortedError,
} from './waitForEvent';

export type {
  DomainEvent,
  DomainEventTopic,
  EventOf,
  PayloadOf,
  LogEventPayload,
  BusHandlerErrorPayload,
  DeviceRegisteredPayload,
  DeviceDeregisteredPayload,
  DevicePowerOnPayload,
  DevicePowerOffPayload,
  DevicePositionChangedPayload,
  DeviceRenamedPayload,
  RegistryClearedPayload,
} from './types';
