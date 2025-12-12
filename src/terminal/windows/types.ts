// Windows Terminal Types

export interface WindowsFileNode {
  name: string;
  type: 'file' | 'directory';
  content?: string;
  children?: Map<string, WindowsFileNode>;
  attributes: FileAttributes;
  size: number;
  modified: Date;
  created: Date;
  accessed: Date;
}

export interface FileAttributes {
  readonly: boolean;
  hidden: boolean;
  system: boolean;
  archive: boolean;
}

export interface WindowsUser {
  username: string;
  fullName: string;
  isAdmin: boolean;
  groups: string[];
  homeDir: string;
  sid: string;
}

export interface WindowsProcess {
  pid: number;
  name: string;
  sessionName: string;
  sessionId: number;
  memUsage: number;
  status: 'Running' | 'Not Responding';
  user: string;
  cpuTime: string;
  windowTitle?: string;
}

export interface WindowsService {
  name: string;
  displayName: string;
  status: 'Running' | 'Stopped' | 'Paused';
  startType: 'Automatic' | 'Manual' | 'Disabled';
}

export interface WindowsTerminalState {
  currentUser: string;
  currentPath: string;
  hostname: string;
  history: string[];
  historyIndex: number;
  env: Record<string, string>;
  aliases: Record<string, string>;
  lastExitCode: number;
  isAdmin: boolean;
  processes: WindowsProcess[];
  shellType: 'cmd' | 'powershell';
}

export interface WindowsOutputLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'system' | 'success';
  content: string;
  timestamp: Date;
  prompt?: string;
}

export interface WindowsCommandResult {
  output: string;
  error?: string;
  exitCode: number;
  clearScreen?: boolean;
  newPath?: string;
  exitTerminal?: boolean;
  switchToPowerShell?: boolean;
  switchToCmd?: boolean;
}

// PowerShell specific types
export interface PSVariable {
  name: string;
  value: PSValue;
  scope: 'Global' | 'Local' | 'Script' | 'Private';
}

export type PSValue =
  | PSString
  | PSInt
  | PSFloat
  | PSBool
  | PSNull
  | PSArray
  | PSHashtable
  | PSObject
  | PSScriptBlock
  | PSDateTime;

export interface PSString {
  type: 'string';
  value: string;
}

export interface PSInt {
  type: 'int';
  value: number;
}

export interface PSFloat {
  type: 'double';
  value: number;
}

export interface PSBool {
  type: 'bool';
  value: boolean;
}

export interface PSNull {
  type: 'null';
}

export interface PSArray {
  type: 'array';
  items: PSValue[];
}

export interface PSHashtable {
  type: 'hashtable';
  entries: Map<string, PSValue>;
}

export interface PSObject {
  type: 'psobject';
  typeName: string;
  properties: Map<string, PSValue>;
  methods: Map<string, PSScriptBlock>;
}

export interface PSScriptBlock {
  type: 'scriptblock';
  code: string;
  params: string[];
}

export interface PSDateTime {
  type: 'datetime';
  value: Date;
}

// Helper functions to create PS values
export function psString(value: string): PSString {
  return { type: 'string', value };
}

export function psInt(value: number): PSInt {
  return { type: 'int', value: Math.floor(value) };
}

export function psFloat(value: number): PSFloat {
  return { type: 'double', value };
}

export function psBool(value: boolean): PSBool {
  return { type: 'bool', value };
}

export function psNull(): PSNull {
  return { type: 'null' };
}

export function psArray(items: PSValue[]): PSArray {
  return { type: 'array', items };
}

export function psHashtable(entries?: Map<string, PSValue>): PSHashtable {
  return { type: 'hashtable', entries: entries || new Map() };
}

export function psDateTime(value: Date): PSDateTime {
  return { type: 'datetime', value };
}

export function psValueToString(value: PSValue): string {
  switch (value.type) {
    case 'string':
      return value.value;
    case 'int':
    case 'double':
      return String(value.value);
    case 'bool':
      return value.value ? 'True' : 'False';
    case 'null':
      return '';
    case 'datetime':
      return value.value.toLocaleString();
    case 'array':
      return value.items.map(psValueToString).join('\n');
    case 'hashtable':
      let result = '';
      value.entries.forEach((v, k) => {
        result += `${k} = ${psValueToString(v)}\n`;
      });
      return result;
    case 'psobject':
      return `[${value.typeName}]`;
    case 'scriptblock':
      return `{${value.code}}`;
    default:
      return '';
  }
}

export function psTruthy(value: PSValue): boolean {
  switch (value.type) {
    case 'bool':
      return value.value;
    case 'int':
    case 'double':
      return value.value !== 0;
    case 'string':
      return value.value.length > 0;
    case 'null':
      return false;
    case 'array':
      return value.items.length > 0;
    case 'hashtable':
      return value.entries.size > 0;
    default:
      return true;
  }
}
