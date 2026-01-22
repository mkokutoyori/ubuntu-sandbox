/**
 * STUB FILE - will be rebuilt with TDD
 * Terminal types for UI compatibility
 */

export interface EditorState {
  isOpen: boolean;
  filePath: string;
  content: string;
  cursorLine: number;
  cursorCol: number;
}

export interface OutputLine {
  id: string;
  text: string;
  type?: 'normal' | 'error' | 'success' | 'warning';
  timestamp?: number;
}

export interface TerminalState {
  currentPath: string;
  output: OutputLine[];
  commandHistory: string[];
  historyIndex: number;
  environment: Record<string, string>;
  editor?: EditorState;
  pythonMode?: boolean;
  sqlMode?: string;
}
