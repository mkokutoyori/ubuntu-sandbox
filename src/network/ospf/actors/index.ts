/**
 * OSPF actors — bus subscribers that carry out the side effects
 * previously hard-coded in `OSPFEngine`.
 *
 * Each actor is a small reactive reducer:
 *   - declares the topics it cares about;
 *   - filters by `routerId + processId` to stay within a single engine
 *     when multiple engines share a global bus;
 *   - calls back into the engine via its public API to perform the
 *     side effect (refresh a signal, schedule SPF, re-originate an LSA).
 *
 * The actor lifecycle (`start()` / `stop()`) is driven by the engine:
 *   - `start()` registers the subscriptions (idempotent);
 *   - `stop()` unsubscribes everything.
 */

export { SignalRefreshActor } from './SignalRefreshActor';
export { SpfActor } from './SpfActor';
export { RouterLsaActor } from './RouterLsaActor';
export { LsaRefreshActor } from './LsaRefreshActor';
export { NetworkLsaActor } from './NetworkLsaActor';
export {
  RoutingTableSyncActor,
  type OspfRoutesInstaller,
} from './RoutingTableSyncActor';
export {
  OspfCaptureActor,
  type CapturedOspfPacket,
  type OspfCaptureFilter,
} from './OspfCaptureActor';
export { OSPFv3SignalRefreshActor } from './OSPFv3SignalRefreshActor';
export { HelloActor } from './HelloActor';
export { RetransmitActor } from './RetransmitActor';
