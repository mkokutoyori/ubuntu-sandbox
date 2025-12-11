// Shell utilities for advanced features
// Glob patterns, command substitution, variables, etc.

import { FileSystem } from './filesystem';
import { commands, parseCommand } from './commands';

// ============================================
// GLOB PATTERN MATCHING
// ============================================

/**
 * Convert glob pattern to regex
 * Supports: * (any chars), ? (single char), [abc] (char class), [!abc] (negated class)
 */
export function globToRegex(pattern: string): RegExp {
  let regex = '^';
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (inCharClass) {
      if (char === ']') {
        regex += ']';
        inCharClass = false;
      } else if (char === '!' && pattern[i - 1] === '[') {
        regex += '^';
      } else {
        regex += char.replace(/[.*+?^${}()|\\]/g, '\\$&');
      }
    } else {
      switch (char) {
        case '*':
          // ** matches any path including /
          if (pattern[i + 1] === '*') {
            regex += '.*';
            i++;
          } else {
            regex += '[^/]*';
          }
          break;
        case '?':
          regex += '[^/]';
          break;
        case '[':
          regex += '[';
          inCharClass = true;
          break;
        case '.':
        case '+':
        case '^':
        case '$':
        case '(':
        case ')':
        case '{':
        case '}':
        case '|':
        case '\\':
          regex += '\\' + char;
          break;
        default:
          regex += char;
      }
    }
  }

  regex += '$';
  return new RegExp(regex);
}

/**
 * Expand glob pattern to matching file paths
 */
export function expandGlob(pattern: string, currentPath: string, fs: FileSystem): string[] {
  // If no glob characters, return as-is
  if (!/[*?\[\]]/.test(pattern)) {
    return [pattern];
  }

  const results: string[] = [];
  const basePath = pattern.startsWith('/') ? '/' : currentPath;
  const patternParts = pattern.replace(/^\//, '').split('/');

  function searchDir(dirPath: string, partIndex: number): void {
    if (partIndex >= patternParts.length) {
      results.push(dirPath === '/' ? '/' : dirPath);
      return;
    }

    const patternPart = patternParts[partIndex];
    const node = fs.getNode(dirPath);

    if (!node || node.type !== 'directory' || !node.children) {
      return;
    }

    // Handle ** (recursive match)
    if (patternPart === '**') {
      // Match current directory
      searchDir(dirPath, partIndex + 1);
      // Recursively search subdirectories
      node.children.forEach((child, name) => {
        if (child.type === 'directory' && !name.startsWith('.')) {
          const childPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
          searchDir(childPath, partIndex); // Stay at same pattern index for **
        }
      });
      return;
    }

    const regex = globToRegex(patternPart);

    node.children.forEach((child, name) => {
      // Don't match hidden files unless pattern starts with .
      if (name.startsWith('.') && !patternPart.startsWith('.')) {
        return;
      }

      if (regex.test(name)) {
        const childPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
        if (partIndex === patternParts.length - 1) {
          results.push(childPath);
        } else if (child.type === 'directory') {
          searchDir(childPath, partIndex + 1);
        }
      }
    });
  }

  searchDir(basePath, 0);

  // Sort results and return original pattern if no matches
  if (results.length === 0) {
    return [pattern];
  }

  return results.sort();
}

/**
 * Expand all glob patterns in an array of arguments
 */
export function expandGlobArgs(args: string[], currentPath: string, fs: FileSystem): string[] {
  const expanded: string[] = [];

  for (const arg of args) {
    // Don't expand if quoted or is an option
    if (arg.startsWith('-') || arg.startsWith("'") || arg.startsWith('"')) {
      expanded.push(arg);
    } else {
      expanded.push(...expandGlob(arg, currentPath, fs));
    }
  }

  return expanded;
}

// ============================================
// COMMAND SUBSTITUTION $(command) and `command`
// ============================================

/**
 * Expand command substitutions in a string
 */
export function expandCommandSubstitution(
  input: string,
  state: any,
  fs: FileSystem,
  pm: any,
  executeCmd: (cmd: string, state: any, fs: FileSystem, pm: any) => any
): string {
  let result = input;

  // Handle $(command) syntax
  const dollarParenRegex = /\$\(([^)]+)\)/g;
  let match;

  while ((match = dollarParenRegex.exec(input)) !== null) {
    const command = match[1];
    const cmdResult = executeCmd(command, state, fs, pm);
    const output = cmdResult.output?.trim() || '';
    result = result.replace(match[0], output);
  }

  // Handle `command` syntax (backticks)
  const backtickRegex = /`([^`]+)`/g;

  while ((match = backtickRegex.exec(result)) !== null) {
    const command = match[1];
    const cmdResult = executeCmd(command, state, fs, pm);
    const output = cmdResult.output?.trim() || '';
    result = result.replace(match[0], output);
  }

  return result;
}

// ============================================
// VARIABLE ASSIGNMENT AND EXPANSION
// ============================================

/**
 * Check if input is a variable assignment (VAR=value)
 */
export function isVariableAssignment(input: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(input);
}

/**
 * Parse variable assignment
 */
export function parseVariableAssignment(input: string): { name: string; value: string } | null {
  const match = input.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) {
    let value = match[2];
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return { name: match[1], value };
  }
  return null;
}

/**
 * Expand environment variables in string
 */
export function expandVariables(input: string, env: Record<string, string>): string {
  // Handle ${VAR} syntax
  let result = input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    return env[name] || '';
  });

  // Handle $VAR syntax (but not $(cmd))
  result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)(?![(\w])/g, (_, name) => {
    return env[name] || '';
  });

  // Handle special variables
  result = result.replace(/\$\?/g, (env['?'] || '0'));
  result = result.replace(/\$\$/g, '1'); // Fake PID

  return result;
}

// ============================================
// LOGICAL OPERATORS (&&, ||, ;)
// ============================================

export interface CommandChain {
  command: string;
  operator: '&&' | '||' | ';' | null;
}

/**
 * Split command by logical operators
 */
export function splitByOperators(input: string): CommandChain[] {
  const chains: CommandChain[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
      current += char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
      current += char;
    } else if (!inQuote) {
      // Check for operators
      if (input.slice(i, i + 2) === '&&') {
        if (current.trim()) {
          chains.push({ command: current.trim(), operator: '&&' });
        }
        current = '';
        i += 2;
        continue;
      } else if (input.slice(i, i + 2) === '||') {
        if (current.trim()) {
          chains.push({ command: current.trim(), operator: '||' });
        }
        current = '';
        i += 2;
        continue;
      } else if (char === ';') {
        if (current.trim()) {
          chains.push({ command: current.trim(), operator: ';' });
        }
        current = '';
        i++;
        continue;
      } else {
        current += char;
      }
    } else {
      current += char;
    }
    i++;
  }

  if (current.trim()) {
    chains.push({ command: current.trim(), operator: null });
  }

  return chains;
}

// ============================================
// BACKGROUND JOBS (&)
// ============================================

/**
 * Check if command should run in background
 */
export function isBackgroundJob(input: string): { command: string; isBackground: boolean } {
  const trimmed = input.trim();
  if (trimmed.endsWith('&') && !trimmed.endsWith('&&')) {
    return {
      command: trimmed.slice(0, -1).trim(),
      isBackground: true
    };
  }
  return { command: trimmed, isBackground: false };
}

// ============================================
// HERE-DOCUMENTS
// ============================================

export interface HereDocument {
  command: string;
  delimiter: string;
  content: string;
}

/**
 * Check if input starts a here-document
 */
export function parseHereDocument(input: string): { hasHereDoc: boolean; command: string; delimiter: string } | null {
  const match = input.match(/(.+?)<<\s*['"]?(\w+)['"]?\s*$/);
  if (match) {
    return {
      hasHereDoc: true,
      command: match[1].trim(),
      delimiter: match[2]
    };
  }
  return null;
}

// ============================================
// TAB COMPLETION HELPERS
// ============================================

/**
 * Get list of all available commands
 */
export function getAvailableCommands(): string[] {
  return Object.keys(commands).sort();
}

/**
 * Get completion suggestions for a partial command
 */
export function getCommandCompletions(partial: string): string[] {
  const allCommands = getAvailableCommands();
  return allCommands.filter(cmd => cmd.startsWith(partial));
}

/**
 * Get file/directory completions
 */
export function getPathCompletions(
  partial: string,
  currentPath: string,
  fs: FileSystem,
  includeHidden: boolean = false
): string[] {
  let dirPath: string;
  let prefix: string;

  if (partial.includes('/')) {
    const lastSlash = partial.lastIndexOf('/');
    dirPath = fs.resolvePath(partial.substring(0, lastSlash) || '/', currentPath);
    prefix = partial.substring(lastSlash + 1);
  } else {
    dirPath = currentPath;
    prefix = partial;
  }

  const node = fs.getNode(dirPath);
  if (!node || node.type !== 'directory' || !node.children) {
    return [];
  }

  const matches: string[] = [];
  node.children.forEach((child, name) => {
    if (name.startsWith(prefix)) {
      if (!name.startsWith('.') || includeHidden || prefix.startsWith('.')) {
        let completion = partial.includes('/')
          ? partial.substring(0, partial.lastIndexOf('/') + 1) + name
          : name;

        // Add trailing slash for directories
        if (child.type === 'directory') {
          completion += '/';
        }
        matches.push(completion);
      }
    }
  });

  return matches.sort();
}

// ============================================
// HISTORY SEARCH
// ============================================

/**
 * Search command history with a pattern
 */
export function searchHistory(history: string[], pattern: string): string[] {
  if (!pattern) return history.slice(-20).reverse();

  const lowerPattern = pattern.toLowerCase();
  return history
    .filter(cmd => cmd.toLowerCase().includes(lowerPattern))
    .slice(-20)
    .reverse();
}

// ============================================
// ACHIEVEMENTS SYSTEM
// ============================================

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  unlocked: boolean;
  unlockedAt?: Date;
  condition: (stats: CommandStats) => boolean;
}

export interface CommandStats {
  commandsExecuted: number;
  uniqueCommands: Set<string>;
  filesCreated: number;
  filesDeleted: number;
  directoriesCreated: number;
  pipesUsed: number;
  sudoUsed: number;
  errorsEncountered: number;
  sessionStart: Date;
}

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_command',
    name: 'Premier Pas',
    description: 'Exécuter votre première commande',
    icon: '🎯',
    unlocked: false,
    condition: (stats) => stats.commandsExecuted >= 1
  },
  {
    id: 'explorer',
    name: 'Explorateur',
    description: 'Utiliser 10 commandes différentes',
    icon: '🧭',
    unlocked: false,
    condition: (stats) => stats.uniqueCommands.size >= 10
  },
  {
    id: 'power_user',
    name: 'Power User',
    description: 'Exécuter 100 commandes',
    icon: '💪',
    unlocked: false,
    condition: (stats) => stats.commandsExecuted >= 100
  },
  {
    id: 'pipe_master',
    name: 'Maître des Pipes',
    description: 'Utiliser 10 pipes',
    icon: '🔗',
    unlocked: false,
    condition: (stats) => stats.pipesUsed >= 10
  },
  {
    id: 'sudo_warrior',
    name: 'Guerrier Sudo',
    description: 'Utiliser sudo 5 fois',
    icon: '🛡️',
    unlocked: false,
    condition: (stats) => stats.sudoUsed >= 5
  },
  {
    id: 'file_creator',
    name: 'Créateur de Fichiers',
    description: 'Créer 10 fichiers',
    icon: '📄',
    unlocked: false,
    condition: (stats) => stats.filesCreated >= 10
  },
  {
    id: 'directory_master',
    name: 'Architecte',
    description: 'Créer 5 répertoires',
    icon: '📁',
    unlocked: false,
    condition: (stats) => stats.directoriesCreated >= 5
  },
  {
    id: 'command_master',
    name: 'Maître des Commandes',
    description: 'Utiliser 30 commandes différentes',
    icon: '👑',
    unlocked: false,
    condition: (stats) => stats.uniqueCommands.size >= 30
  },
  {
    id: 'night_owl',
    name: 'Hibou de Nuit',
    description: 'Utiliser le terminal après 22h',
    icon: '🦉',
    unlocked: false,
    condition: () => new Date().getHours() >= 22 || new Date().getHours() < 6
  },
  {
    id: 'error_handler',
    name: 'Résilient',
    description: 'Rencontrer 10 erreurs et continuer',
    icon: '🔧',
    unlocked: false,
    condition: (stats) => stats.errorsEncountered >= 10
  },
  {
    id: 'speed_demon',
    name: 'Démon de Vitesse',
    description: 'Exécuter 50 commandes en moins de 5 minutes',
    icon: '⚡',
    unlocked: false,
    condition: (stats) => {
      const elapsed = (new Date().getTime() - stats.sessionStart.getTime()) / 1000 / 60;
      return stats.commandsExecuted >= 50 && elapsed < 5;
    }
  },
  {
    id: 'clean_freak',
    name: 'Maniaque du Nettoyage',
    description: 'Supprimer 20 fichiers',
    icon: '🧹',
    unlocked: false,
    condition: (stats) => stats.filesDeleted >= 20
  }
];

// ============================================
// TUTORIAL SYSTEM
// ============================================

export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  command: string;
  hint: string;
  validator: (input: string, output: string) => boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'intro',
    title: 'Bienvenue !',
    description: 'Bienvenue dans le tutoriel Linux ! Commençons par afficher le répertoire courant.',
    command: 'pwd',
    hint: 'Tapez "pwd" pour afficher le répertoire de travail actuel',
    validator: (input) => input.trim() === 'pwd'
  },
  {
    id: 'list',
    title: 'Lister les fichiers',
    description: 'Maintenant, listons les fichiers dans le répertoire courant.',
    command: 'ls',
    hint: 'Tapez "ls" pour lister les fichiers',
    validator: (input) => input.trim().startsWith('ls')
  },
  {
    id: 'list_details',
    title: 'Liste détaillée',
    description: 'Affichons plus de détails sur les fichiers avec l\'option -l.',
    command: 'ls -l',
    hint: 'Tapez "ls -l" pour une liste détaillée',
    validator: (input) => input.includes('ls') && input.includes('-l')
  },
  {
    id: 'change_dir',
    title: 'Changer de répertoire',
    description: 'Allons dans le répertoire Documents.',
    command: 'cd Documents',
    hint: 'Tapez "cd Documents" pour entrer dans le dossier',
    validator: (input) => input.trim().startsWith('cd')
  },
  {
    id: 'go_back',
    title: 'Retour en arrière',
    description: 'Revenons au répertoire parent avec cd ..',
    command: 'cd ..',
    hint: 'Tapez "cd .." pour remonter d\'un niveau',
    validator: (input) => input.trim() === 'cd ..' || input.trim() === 'cd ..'
  },
  {
    id: 'create_file',
    title: 'Créer un fichier',
    description: 'Créons un nouveau fichier avec touch.',
    command: 'touch monfichier.txt',
    hint: 'Tapez "touch monfichier.txt" pour créer un fichier',
    validator: (input) => input.trim().startsWith('touch')
  },
  {
    id: 'write_file',
    title: 'Écrire dans un fichier',
    description: 'Écrivons du texte dans le fichier avec echo et la redirection.',
    command: 'echo "Hello World" > monfichier.txt',
    hint: 'Tapez "echo "Hello World" > monfichier.txt"',
    validator: (input) => input.includes('echo') && input.includes('>')
  },
  {
    id: 'read_file',
    title: 'Lire un fichier',
    description: 'Lisons le contenu du fichier avec cat.',
    command: 'cat monfichier.txt',
    hint: 'Tapez "cat monfichier.txt" pour afficher le contenu',
    validator: (input) => input.trim().startsWith('cat')
  },
  {
    id: 'create_dir',
    title: 'Créer un répertoire',
    description: 'Créons un nouveau répertoire.',
    command: 'mkdir mondossier',
    hint: 'Tapez "mkdir mondossier" pour créer un dossier',
    validator: (input) => input.trim().startsWith('mkdir')
  },
  {
    id: 'pipes',
    title: 'Utiliser les pipes',
    description: 'Combinons des commandes avec le pipe |',
    command: 'ls -l | grep txt',
    hint: 'Tapez "ls -l | grep txt" pour filtrer les fichiers .txt',
    validator: (input) => input.includes('|')
  },
  {
    id: 'completion',
    title: 'Félicitations !',
    description: 'Vous avez terminé le tutoriel de base ! Continuez à explorer.',
    command: 'neofetch',
    hint: 'Installez neofetch avec "apt install neofetch" puis lancez-le',
    validator: () => true
  }
];
