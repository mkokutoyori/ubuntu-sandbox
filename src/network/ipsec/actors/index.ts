/**
 * IPSec actors — bus subscribers that own the side-effects of IPSec
 * domain events.
 *
 * Each actor:
 *  - declares the topics it cares about;
 *  - filters by `deviceId` so multiple engines on a shared bus stay
 *    isolated;
 *  - calls back into the engine via its actor-API.
 *
 * Lifecycle is driven by the engine: `start()` registers the
 * subscriptions (idempotent), `stop()` unsubscribes everything.
 */

export { IPSecSignalRefreshActor } from './IPSecSignalRefreshActor';
