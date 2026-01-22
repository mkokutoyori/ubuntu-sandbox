/**
 * STUB FILE - will be rebuilt with TDD
 * Windows PowerShell implementation
 */

export interface PSContext {
  variables: Record<string, any>;
  functions: Record<string, Function>;
  modules: string[];
  executionPolicy: string;
  currentLocation: string;
}

export interface PSResult {
  output: string;
  exitCode: number;
  newPath?: string;
  hasError: boolean;
}

export function createPSContext(): PSContext {
  return {
    variables: {
      '$PSVersionTable': {
        PSVersion: '5.1',
        PSEdition: 'Desktop',
        BuildVersion: '10.0.19041.1'
      }
    },
    functions: {},
    modules: [],
    executionPolicy: 'RemoteSigned',
    currentLocation: 'C:\\Users\\User'
  };
}

export async function executePSCommand(
  command: string,
  context: PSContext
): Promise<PSResult> {
  const cmd = command.trim().toLowerCase();

  // Stub implementations for common PowerShell commands
  if (cmd.startsWith('get-childitem') || cmd === 'ls' || cmd === 'dir') {
    return {
      output: 'STUB: Directory listing',
      exitCode: 0,
      hasError: false
    };
  }

  if (cmd.startsWith('set-location') || cmd.startsWith('cd ')) {
    const newPath = command.split(/\s+/)[1] || 'C:\\Users\\User';
    return {
      output: '',
      exitCode: 0,
      newPath,
      hasError: false
    };
  }

  if (cmd.startsWith('get-content') || cmd.startsWith('cat ')) {
    return {
      output: 'STUB: File contents',
      exitCode: 0,
      hasError: false
    };
  }

  if (cmd.startsWith('write-host') || cmd.startsWith('echo ')) {
    const text = command.substring(command.indexOf(' ') + 1);
    return {
      output: text,
      exitCode: 0,
      hasError: false
    };
  }

  if (cmd === 'exit') {
    return {
      output: '',
      exitCode: 0,
      hasError: false
    };
  }

  return {
    output: `STUB: PowerShell execution result for: ${command}`,
    exitCode: 0,
    hasError: false
  };
}
