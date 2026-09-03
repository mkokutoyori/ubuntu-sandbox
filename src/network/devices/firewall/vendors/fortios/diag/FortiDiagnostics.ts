import type { FirewallLogLevel, FirewallLogType } from '../../../logging/FirewallLogStore';
import { makeDebugFlowState, type DebugFlowState } from './debugFlowRenderer';
import { clearFilter, type SessionFilter } from './sessionListRenderer';
import type { AuthListFilter } from './authListRenderer';

export interface LogViewFilter {
  category: FirewallLogType;
  subtype?: string;
  level?: FirewallLogLevel;
  fields: Map<string, string>;
  viewLines: number;
}

export class FortiDiagnostics {
  readonly sessionFilter: SessionFilter = {};
  readonly session6Filter: SessionFilter = {};
  readonly debugFlow: DebugFlowState = makeDebugFlowState();
  authFilter: AuthListFilter = {};
  readonly logFilter: LogViewFilter = {
    category: 'traffic', subtype: undefined, fields: new Map(), viewLines: 0,
  };

  clearSessionFilter(): void {
    clearFilter(this.sessionFilter);
  }

  resetDebug(): void {
    this.debugFlow.enabled = false;
    this.debugFlow.traceCount = 0;
    this.debugFlow.showFunctionName = false;
    this.debugFlow.showConsole = true;
    this.debugFlow.filter = {};
  }

  clearLogFilter(): void {
    this.logFilter.category = 'traffic';
    this.logFilter.subtype = undefined;
    this.logFilter.level = undefined;
    this.logFilter.fields.clear();
    this.logFilter.viewLines = 0;
  }
}
