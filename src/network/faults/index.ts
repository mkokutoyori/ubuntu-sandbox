/**
 * Fault registry — the current set of things that are wrong across the
 * topology (docs/PRD-Pannes.md §6.1).
 *
 * Entry point: call `ensureFaultProjection()` once the event bus exists,
 * then read `getFaultRegistry()`.
 */

export type {
  Fault,
  ResolvedFault,
  FaultCode,
  FaultCategory,
  FaultSeverity,
  FaultCatalogEntry,
} from './FaultTypes';
export {
  SEVERITY_ORDER,
  maxSeverity,
  loggerLevelFor,
  faultId,
} from './FaultTypes';
export { FAULT_CATALOG, catalogEntry } from './faultCatalog';
export {
  FaultRegistry,
  getFaultRegistry,
  resetFaultRegistry,
  __setFaultRegistry,
  type RaiseFaultInput,
  type FaultListener,
} from './FaultRegistry';
export {
  FaultProjection,
  ensureFaultProjection,
  __resetFaultProjection,
} from './FaultProjection';
