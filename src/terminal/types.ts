// File System Types
export interface FileNode {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  content?: string;
  children?: Map<string, FileNode>;
  permissions: string;
  owner: string;
  group: string;
  size: number;
  modified: Date;
  created: Date;
  target?: string; // For symlinks
}

export interface User {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  password: string; // Hashed
  groups: string[];
}

export interface Group {
  name: string;
  gid: number;
  members: string[];
}

export interface Process {
  pid: number;
  ppid: number;
  user: string;
  command: string;
  state: 'R' | 'S' | 'D' | 'Z' | 'T';
  cpu: number;
  mem: number;
  startTime: Date;
  tty: string;
}

export interface Package {
  name: string;
  version: string;
  description: string;
  installed: boolean;
  size: string;
}

export interface TerminalState {
  currentUser: string;
  currentPath: string;
  hostname: string;
  history: string[];
  historyIndex: number;
  env: Record<string, string>;
  aliases: Record<string, string>;
  lastExitCode: number;
  isRoot: boolean;
  processes: Process[];
  backgroundJobs: Process[];
}

export interface OutputLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'system' | 'success';
  content: string;
  timestamp: Date;
  prompt?: string;
}

export interface CommandResult {
  output: string;
  error?: string;
  exitCode: number;
  clearScreen?: boolean;
  newPath?: string;
  newUser?: string;
  editorMode?: EditorState;
}

export interface EditorState {
  type: 'nano' | 'vi' | 'vim';
  filePath: string;
  content: string;
  cursorLine: number;
  cursorCol: number;
  mode: 'normal' | 'insert' | 'command' | 'visual';
  modified: boolean;
  message?: string;
}

export interface TabCompletion {
  suggestions: string[];
  partial: string;
}
