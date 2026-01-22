/**
 * STUB FILE - will be rebuilt with TDD
 * Shell utility functions
 */

export function expandPath(path: string, homeDir: string = '/home/user'): string {
  if (path.startsWith('~')) {
    return path.replace('~', homeDir);
  }
  return path;
}

export function parseCommand(input: string): { command: string; args: string[] } {
  const parts = input.trim().split(/\s+/);
  return {
    command: parts[0] || '',
    args: parts.slice(1)
  };
}

export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

export function getPrompt(username: string, hostname: string, currentPath: string): string {
  const displayPath = currentPath.replace(`/home/${username}`, '~');
  return `${username}@${hostname}:${displayPath}$ `;
}

// Achievement system types
export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  unlocked: boolean;
  unlockedAt?: number;
}

export interface CommandStats {
  totalCommands: number;
  uniqueCommands: Set<string>;
  achievements: Achievement[];
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-command', name: 'First Steps', description: 'Execute your first command', icon: '🎯', unlocked: false },
  { id: 'explorer', name: 'Explorer', description: 'Navigate through 10 directories', icon: '🗺️', unlocked: false },
  { id: 'power-user', name: 'Power User', description: 'Use 25 different commands', icon: '⚡', unlocked: false },
];

// Tutorial steps types
export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  command?: string;
  completed: boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  { id: 'ls', title: 'List Files', description: 'Try the "ls" command to list files', command: 'ls', completed: false },
  { id: 'cd', title: 'Change Directory', description: 'Use "cd" to navigate', command: 'cd', completed: false },
  { id: 'pwd', title: 'Print Working Directory', description: 'Use "pwd" to see your current location', command: 'pwd', completed: false },
];

// Command completion
export function getCommandCompletions(partial: string): string[] {
  const commonCommands = ['ls', 'cd', 'pwd', 'cat', 'echo', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'grep', 'find', 'chmod', 'chown'];
  return commonCommands.filter(cmd => cmd.startsWith(partial));
}

// Path completion
export function getPathCompletions(partial: string, currentDir: string): string[] {
  // STUB: Returns empty array
  return [];
}

// History search
export function searchHistory(query: string, history: string[]): string[] {
  return history.filter(cmd => cmd.includes(query));
}
