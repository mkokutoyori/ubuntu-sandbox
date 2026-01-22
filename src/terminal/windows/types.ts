/**
 * STUB FILE - will be rebuilt with TDD
 * Windows terminal types
 */

export interface WindowsOutputLine {
  id: string;
  text: string;
  type?: 'normal' | 'error' | 'success' | 'warning';
  timestamp?: number;
}

export interface WindowsTerminalState {
  currentPath: string;
  output: WindowsOutputLine[];
  commandHistory: string[];
  historyIndex: number;
  environment: Record<string, string>;
  shellType: 'cmd' | 'powershell';
  psContext?: any; // PowerShell context
}
