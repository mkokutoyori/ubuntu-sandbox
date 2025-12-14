/**
 * Windows Terminal Component
 * Supports both CMD and PowerShell modes
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { WindowsFileSystem, windowsFileSystem as globalWindowsFileSystem } from '@/terminal/windows/filesystem';
import { executeCmdCommand } from '@/terminal/windows/commands';
import { createPSContext, executePSCommand, PSContext } from '@/terminal/windows/powershell';
import { WindowsTerminalState, WindowsOutputLine } from '@/terminal/windows/types';
import { BaseDevice } from '@/devices';

const generateId = () => Math.random().toString(36).substr(2, 9);

/**
 * Handle tab completion for file paths in Windows terminal
 */
function handleTabCompletion(
  input: string,
  currentPath: string,
  fs: WindowsFileSystem
): string {
  // Find the last word being typed (the one to complete)
  const words = input.split(/\s+/);
  if (words.length === 0) return input;

  const lastWord = words[words.length - 1];
  if (!lastWord) return input;

  // Determine the directory to search and the prefix to match
  let searchDir: string;
  let prefix: string;
  let pathPrefix = '';

  if (lastWord.includes('\\')) {
    // Path with backslash - get directory part and file prefix
    const lastSlash = lastWord.lastIndexOf('\\');
    pathPrefix = lastWord.substring(0, lastSlash + 1);
    prefix = lastWord.substring(lastSlash + 1).toLowerCase();

    // Resolve the search directory
    if (pathPrefix.match(/^[A-Za-z]:\\/)) {
      // Absolute path
      searchDir = pathPrefix;
    } else {
      // Relative path
      searchDir = fs.resolvePath(pathPrefix, currentPath);
    }
  } else {
    // Just a filename prefix - search current directory
    searchDir = currentPath;
    prefix = lastWord.toLowerCase();
  }

  // List directory and find matches
  const entries = fs.listDirectory(searchDir);
  if (!entries) return input;

  const matches = entries.filter(entry =>
    entry.name.toLowerCase().startsWith(prefix)
  );

  if (matches.length === 0) {
    return input;
  }

  if (matches.length === 1) {
    // Single match - complete it
    const match = matches[0];
    const completion = match.name + (match.type === 'directory' ? '\\' : '');
    const newWords = [...words.slice(0, -1), pathPrefix + completion];
    return newWords.join(' ');
  }

  // Multiple matches - find common prefix
  const names = matches.map(m => m.name);
  let commonPrefix = names[0];
  for (const name of names) {
    while (!name.toLowerCase().startsWith(commonPrefix.toLowerCase()) && commonPrefix.length > 0) {
      commonPrefix = commonPrefix.slice(0, -1);
    }
  }

  if (commonPrefix.length > prefix.length) {
    // Use the matching case from the first match
    const firstMatch = matches.find(m =>
      m.name.toLowerCase().startsWith(commonPrefix.toLowerCase())
    );
    const actualPrefix = firstMatch ? firstMatch.name.substring(0, commonPrefix.length) : commonPrefix;
    const newWords = [...words.slice(0, -1), pathPrefix + actualPrefix];
    return newWords.join(' ');
  }

  return input;
}

interface WindowsTerminalProps {
  device?: BaseDevice;
  onRequestClose?: () => void;
}

export const WindowsTerminal: React.FC<WindowsTerminalProps> = ({ device, onRequestClose }) => {
  // Use device's filesystem if available, otherwise fall back to global singleton
  const windowsFileSystem = useMemo(() => {
    if (device && device.getFileSystem()) {
      return device.getFileSystem() as WindowsFileSystem;
    }
    return globalWindowsFileSystem;
  }, [device]);
  // Get hostname from device if available
  const deviceHostname = device?.getHostname()?.toUpperCase() || 'DESKTOP-NETSIM';

  const [state, setState] = useState<WindowsTerminalState>(() => ({
    currentUser: 'User',
    currentPath: 'C:\\Users\\User',
    hostname: deviceHostname,
    history: [],
    historyIndex: -1,
    env: {
      COMPUTERNAME: deviceHostname,
      USERNAME: 'User',
      USERPROFILE: 'C:\\Users\\User',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\User',
      PATH: 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\',
      PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1',
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      TEMP: 'C:\\Users\\User\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\User\\AppData\\Local\\Temp',
      PROCESSOR_ARCHITECTURE: 'AMD64',
      NUMBER_OF_PROCESSORS: '4',
      OS: 'Windows_NT',
    },
    aliases: {},
    lastExitCode: 0,
    isAdmin: false,
    processes: [],
    shellType: 'cmd',
  }));

  const [output, setOutput] = useState<WindowsOutputLine[]>([]);
  const [input, setInput] = useState('');
  const [booted, setBooted] = useState(false);
  const [psContext, setPsContext] = useState<PSContext | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Boot sequence
  useEffect(() => {
    const bootMessages = state.shellType === 'powershell'
      ? [
          'Windows PowerShell',
          'Copyright (C) Microsoft Corporation. All rights reserved.',
          '',
          'Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows',
          '',
        ]
      : [
          'Microsoft Windows [Version 10.0.22621.2428]',
          '(c) Microsoft Corporation. All rights reserved.',
          '',
        ];

    const bootSequence = async () => {
      for (let i = 0; i < bootMessages.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 30));
        setOutput(prev => [...prev, {
          id: generateId(),
          type: 'system',
          content: bootMessages[i],
          timestamp: new Date(),
        }]);
      }
      setBooted(true);
    };

    bootSequence();
  }, [state.shellType]);

  // Auto-scroll
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  // Focus input
  useEffect(() => {
    if (booted) {
      inputRef.current?.focus();
    }
  }, [booted, output]);

  // Initialize PowerShell context when switching to PowerShell
  useEffect(() => {
    if (state.shellType === 'powershell' && !psContext) {
      setPsContext(createPSContext(windowsFileSystem, state));
    }
  }, [state.shellType, psContext, state]);

  const getPrompt = useCallback(() => {
    if (state.shellType === 'powershell') {
      return `PS ${state.currentPath}> `;
    }
    return `${state.currentPath}>`;
  }, [state.currentPath, state.shellType]);

  const handleCommand = useCallback((cmd: string) => {
    const prompt = getPrompt();

    // Add input to output
    setOutput(prev => [...prev, {
      id: generateId(),
      type: 'input',
      content: cmd,
      timestamp: new Date(),
      prompt,
    }]);

    // Add to history
    if (cmd.trim()) {
      setState(prev => ({
        ...prev,
        history: [...prev.history, cmd],
        historyIndex: -1,
      }));
    }

    // Execute command based on shell type
    if (state.shellType === 'powershell') {
      // Execute PowerShell command
      let ctx = psContext;
      if (!ctx) {
        ctx = createPSContext(windowsFileSystem, state);
        setPsContext(ctx);
      }

      // Update context path
      ctx.state = { ...state };
      ctx.variables.set('PWD', { type: 'string', value: state.currentPath });

      const result = executePSCommand(cmd, ctx);

      if (result.output) {
        setOutput(prev => [...prev, {
          id: generateId(),
          type: result.exitCode === 0 ? 'output' : 'error',
          content: result.output,
          timestamp: new Date(),
        }]);
      }

      if (result.exitTerminal) {
        onRequestClose?.();
        return;
      }

      if (result.switchToCmd) {
        setState(prev => ({ ...prev, shellType: 'cmd' }));
        setOutput([]);
        setBooted(false);
        setTimeout(() => {
          setOutput([
            { id: generateId(), type: 'system', content: 'Microsoft Windows [Version 10.0.22621.2428]', timestamp: new Date() },
            { id: generateId(), type: 'system', content: '(c) Microsoft Corporation. All rights reserved.', timestamp: new Date() },
            { id: generateId(), type: 'system', content: '', timestamp: new Date() },
          ]);
          setBooted(true);
        }, 100);
      }

      if (result.newPath) {
        setState(prev => ({ ...prev, currentPath: result.newPath! }));
      }

      // Handle Clear-Host
      if (result.output?.includes('\x1b[2J')) {
        setOutput([]);
      }
    } else {
      // Execute CMD command
      const result = executeCmdCommand(cmd, state, windowsFileSystem);

      if (result.clearScreen) {
        setOutput([]);
      } else {
        if (result.output) {
          setOutput(prev => [...prev, {
            id: generateId(),
            type: 'output',
            content: result.output,
            timestamp: new Date(),
          }]);
        }
        if (result.error) {
          setOutput(prev => [...prev, {
            id: generateId(),
            type: 'error',
            content: result.error,
            timestamp: new Date(),
          }]);
        }
      }

      if (result.exitTerminal) {
        onRequestClose?.();
        return;
      }

      if (result.switchToPowerShell) {
        setState(prev => ({ ...prev, shellType: 'powershell' }));
        setOutput([]);
        setBooted(false);
        setPsContext(null);
        setTimeout(() => {
          setOutput([
            { id: generateId(), type: 'system', content: 'Windows PowerShell', timestamp: new Date() },
            { id: generateId(), type: 'system', content: 'Copyright (C) Microsoft Corporation. All rights reserved.', timestamp: new Date() },
            { id: generateId(), type: 'system', content: '', timestamp: new Date() },
            { id: generateId(), type: 'system', content: 'Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows', timestamp: new Date() },
            { id: generateId(), type: 'system', content: '', timestamp: new Date() },
          ]);
          setBooted(true);
        }, 100);
      }

      if (result.newPath) {
        setState(prev => ({ ...prev, currentPath: result.newPath! }));
      }
    }

    setInput('');
  }, [state, getPrompt, psContext, onRequestClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.history.length > 0) {
        const newIndex = state.historyIndex === -1
          ? state.history.length - 1
          : Math.max(0, state.historyIndex - 1);
        setState(prev => ({ ...prev, historyIndex: newIndex }));
        setInput(state.history[newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.historyIndex !== -1) {
        const newIndex = state.historyIndex + 1;
        if (newIndex >= state.history.length) {
          setState(prev => ({ ...prev, historyIndex: -1 }));
          setInput('');
        } else {
          setState(prev => ({ ...prev, historyIndex: newIndex }));
          setInput(state.history[newIndex] || '');
        }
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Tab completion for paths
      const completedInput = handleTabCompletion(input, state.currentPath, windowsFileSystem);
      if (completedInput !== input) {
        setInput(completedInput);
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      setOutput(prev => [...prev, {
        id: generateId(),
        type: 'input',
        content: input + '^C',
        timestamp: new Date(),
        prompt: getPrompt(),
      }]);
      setInput('');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setOutput([]);
    }
  }, [input, state, handleCommand, getPrompt]);

  const renderLine = (line: WindowsOutputLine) => {
    const colorClass = {
      input: 'text-white',
      output: 'text-gray-200',
      error: 'text-red-400',
      system: 'text-gray-400',
      success: 'text-green-400',
    }[line.type];

    if (line.type === 'input') {
      return (
        <div key={line.id} className="flex">
          <span className={`${state.shellType === 'powershell' ? 'text-yellow-300' : 'text-gray-400'} mr-1 whitespace-pre`}>
            {line.prompt}
          </span>
          <span className={`${colorClass} whitespace-pre`}>{line.content}</span>
        </div>
      );
    }

    return (
      <pre key={line.id} className={`${colorClass} whitespace-pre-wrap break-all`}>
        {line.content}
      </pre>
    );
  };

  const bgColor = state.shellType === 'powershell' ? 'bg-[#012456]' : 'bg-black';
  const promptColor = state.shellType === 'powershell' ? 'text-yellow-300' : 'text-gray-400';

  return (
    <div
      className={`h-full w-full ${bgColor} overflow-hidden flex flex-col font-mono text-sm`}
      onClick={() => inputRef.current?.focus()}
    >
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3"
      >
        {output.map(renderLine)}

        {booted && (
          <div className="flex items-center">
            <span className={`${promptColor} mr-1 whitespace-pre`}>{getPrompt()}</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className={`flex-1 ${bgColor} text-white outline-none caret-white font-mono`}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </div>
        )}
      </div>
    </div>
  );
};
