/**
 * Cisco IOS Terminal Component
 * Full-featured Cisco CLI emulator for routers and switches
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  CiscoConfig,
  CiscoTerminalState,
  CiscoOutputLine,
  CiscoDeviceType,
  generateId,
} from '@/terminal/cisco/types';
import {
  createDefaultRouterConfig,
  createDefaultSwitchConfig,
  createDefaultTerminalState,
  getPrompt,
  executeCiscoCommand,
} from '@/terminal/cisco';

interface CiscoTerminalProps {
  deviceType?: CiscoDeviceType;
  hostname?: string;
  onRequestClose?: () => void;
}

export const CiscoTerminal: React.FC<CiscoTerminalProps> = ({
  deviceType = 'router',
  hostname,
  onRequestClose,
}) => {
  // Initialize configuration based on device type
  const [config] = useState<CiscoConfig>(() => {
    const cfg = deviceType === 'switch'
      ? createDefaultSwitchConfig(hostname || 'Switch')
      : createDefaultRouterConfig(hostname || 'Router');
    return cfg;
  });

  // Terminal state
  const [state, setState] = useState<CiscoTerminalState>(() =>
    createDefaultTerminalState(config.hostname)
  );

  // Output buffer
  const [output, setOutput] = useState<CiscoOutputLine[]>([]);

  // Current input
  const [input, setInput] = useState('');

  // Boot state
  const [booted, setBooted] = useState(false);

  // Boot time for uptime calculation
  const [bootTime] = useState(new Date());

  // Password input mode
  const [passwordMode, setPasswordMode] = useState(false);

  // More pagination
  const [moreMode, setMoreMode] = useState(false);
  const [pendingOutput, setPendingOutput] = useState<string[]>([]);

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Boot sequence
  useEffect(() => {
    const bootMessages = deviceType === 'router'
      ? [
          '',
          'System Bootstrap, Version 15.1(4)M12, RELEASE SOFTWARE (fc1)',
          'Technical Support: http://www.cisco.com/techsupport',
          'Copyright (c) 2006-2024 by cisco Systems, Inc.',
          '',
          'Initializing memory and verifying content...',
          'Loading "flash:c4331-adventerprisek9-mz.SPA.151-4.M12.bin"...',
          '',
          '              Restricted Rights Legend',
          '',
          'Use, duplication, or disclosure by the Government is',
          'subject to restrictions as set forth in subparagraph',
          '(c) of the Commercial Computer Software - Restricted',
          'Rights clause at FAR sec. 52.227-19 and subparagraph',
          '(c) (1) (ii) of the Rights in Technical Data and Computer',
          'Software clause at DFARS sec. 252.227-7013.',
          '',
          '           cisco Systems, Inc.',
          '           170 West Tasman Drive',
          '           San Jose, California 95134-1706',
          '',
          'Cisco IOS Software, ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 15.1(4)M12',
          'Technical Support: http://www.cisco.com/techsupport',
          'Copyright (c) 1986-2024 by Cisco Systems, Inc.',
          'Compiled Tue 04-Mar-24 12:00',
          '',
          `${config.hostname} con0 is now available`,
          '',
          'Press RETURN to get started.',
          '',
        ]
      : [
          '',
          'Base ethernet MAC Address: 00:00:0c:12:34:56',
          'Xmodem file system is available.',
          'The password-recovery mechanism is enabled.',
          '',
          'Initializing Flash...',
          'flashfs[0]: 2 files, 1 directories',
          'flashfs[0]: 0 orphaned files, 0 orphaned directories',
          'flashfs[0]: Total bytes: 65536000',
          'flashfs[0]: Bytes used: 12345600',
          'flashfs[0]: Bytes available: 53190400',
          'flashfs[0]: flashfs fsck took 1 seconds.',
          '...done Initializing Flash.',
          '',
          'Loading "flash:c2960-lanbasek9-mz.150-2.SE11.bin"...',
          '',
          '              Restricted Rights Legend',
          '',
          'Use, duplication, or disclosure by the Government is',
          'subject to restrictions as set forth in subparagraph',
          '(c) of the Commercial Computer Software - Restricted',
          'Rights clause at FAR sec. 52.227-19 and subparagraph',
          '(c) (1) (ii) of the Rights in Technical Data and Computer',
          'Software clause at DFARS sec. 252.227-7013.',
          '',
          '           cisco Systems, Inc.',
          '           170 West Tasman Drive',
          '           San Jose, California 95134-1706',
          '',
          'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE11',
          'Technical Support: http://www.cisco.com/techsupport',
          'Copyright (c) 1986-2024 by Cisco Systems, Inc.',
          'Compiled Tue 04-Mar-24 12:00',
          '',
          `${config.hostname} con0 is now available`,
          '',
          'Press RETURN to get started.',
          '',
        ];

    const bootSequence = async () => {
      for (let i = 0; i < bootMessages.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 30));
        setOutput(prev => [
          ...prev,
          {
            id: generateId(),
            type: 'system',
            content: bootMessages[i],
            timestamp: new Date(),
          },
        ]);
      }
      setBooted(true);
    };

    bootSequence();
  }, [deviceType, config.hostname]);

  // Auto-scroll
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  // Focus input
  useEffect(() => {
    if (booted && !moreMode) {
      inputRef.current?.focus();
    }
  }, [booted, output, moreMode]);

  // Update hostname in state when config changes
  useEffect(() => {
    setState(prev => ({ ...prev, hostname: config.hostname }));
  }, [config.hostname]);

  const currentPrompt = useCallback(() => {
    if (passwordMode) {
      return 'Password: ';
    }
    return getPrompt(state);
  }, [state, passwordMode]);

  const handleCommand = useCallback(
    (cmd: string) => {
      const prompt = currentPrompt();

      // Add input to output (hide password)
      setOutput(prev => [
        ...prev,
        {
          id: generateId(),
          type: 'input',
          content: passwordMode ? '' : cmd,
          timestamp: new Date(),
          prompt,
        },
      ]);

      // Handle password mode
      if (passwordMode) {
        setPasswordMode(false);
        // Check password (for simulation, accept any password)
        setState(prev => ({
          ...prev,
          mode: 'privileged',
          isAuthenticated: true,
        }));
        setInput('');
        return;
      }

      // Add to history (except empty and duplicate last)
      if (cmd.trim() && cmd !== state.history[state.history.length - 1]) {
        setState(prev => ({
          ...prev,
          history: [...prev.history.slice(-99), cmd],
          historyIndex: -1,
        }));
      }

      // Handle exit commands
      if (cmd.trim().toLowerCase() === 'exit' && state.mode === 'user') {
        if (onRequestClose) {
          onRequestClose();
        }
        return;
      }

      // Execute command
      const result = executeCiscoCommand(cmd, state, config, bootTime);

      // Handle output
      if (result.output) {
        // Check if we need pagination
        const lines = result.output.split('\n');
        if (lines.length > state.terminalLength && state.terminalLength > 0) {
          // Show first page
          const firstPage = lines.slice(0, state.terminalLength - 1);
          setOutput(prev => [
            ...prev,
            {
              id: generateId(),
              type: 'output',
              content: firstPage.join('\n'),
              timestamp: new Date(),
            },
          ]);
          // Store remaining for --More--
          setPendingOutput(lines.slice(state.terminalLength - 1));
          setMoreMode(true);
        } else {
          setOutput(prev => [
            ...prev,
            {
              id: generateId(),
              type: result.error ? 'error' : 'output',
              content: result.output,
              timestamp: new Date(),
            },
          ]);
        }
      }

      if (result.error && !result.output) {
        setOutput(prev => [
          ...prev,
          {
            id: generateId(),
            type: 'error',
            content: result.error,
            timestamp: new Date(),
          },
        ]);
      }

      // Handle clear screen
      if (result.clearScreen) {
        setOutput([]);
      }

      // Update state based on result
      setState(prev => {
        const newState = { ...prev };

        if (result.newMode !== undefined) {
          newState.mode = result.newMode;
        }
        if (result.newInterface !== undefined) {
          newState.currentInterface = result.newInterface;
        }
        if (result.newLine !== undefined) {
          newState.currentLine = result.newLine;
        }
        if (result.newRouter !== undefined) {
          newState.currentRouter = result.newRouter;
        }
        if (result.newVlan !== undefined) {
          newState.currentVlan = result.newVlan;
        }
        if (result.newACL !== undefined) {
          newState.currentACL = result.newACL;
        }
        if (result.newDHCPPool !== undefined) {
          newState.currentDHCPPool = result.newDHCPPool;
        }

        // Clear context when going to higher modes
        if (result.newMode === 'global-config') {
          newState.currentInterface = undefined;
          newState.currentLine = undefined;
          newState.currentRouter = undefined;
          newState.currentVlan = undefined;
          newState.currentACL = undefined;
          newState.currentDHCPPool = undefined;
        }
        if (result.newMode === 'privileged' || result.newMode === 'user') {
          newState.currentInterface = undefined;
          newState.currentLine = undefined;
          newState.currentRouter = undefined;
          newState.currentVlan = undefined;
          newState.currentACL = undefined;
          newState.currentDHCPPool = undefined;
        }

        return newState;
      });

      setInput('');
    },
    [state, config, bootTime, passwordMode, currentPrompt, onRequestClose]
  );

  const handleMoreKey = useCallback(
    (key: string) => {
      if (!moreMode) return;

      if (key === 'q' || key === 'Q') {
        // Quit more
        setMoreMode(false);
        setPendingOutput([]);
        return;
      }

      if (key === ' ' || key === 'Enter') {
        // Show next page or line
        const linesToShow = key === ' ' ? state.terminalLength - 1 : 1;
        const nextLines = pendingOutput.slice(0, linesToShow);
        const remaining = pendingOutput.slice(linesToShow);

        setOutput(prev => [
          ...prev,
          {
            id: generateId(),
            type: 'output',
            content: nextLines.join('\n'),
            timestamp: new Date(),
          },
        ]);

        if (remaining.length === 0) {
          setMoreMode(false);
          setPendingOutput([]);
        } else {
          setPendingOutput(remaining);
        }
      }
    },
    [moreMode, pendingOutput, state.terminalLength]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Handle --More-- mode
      if (moreMode) {
        e.preventDefault();
        handleMoreKey(e.key);
        return;
      }

      if (e.key === 'Enter') {
        handleCommand(input);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (state.history.length > 0) {
          const newIndex =
            state.historyIndex === -1
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
        // Command completion
        if (input && !input.includes(' ')) {
          // Try to complete command
          const completed = tryCompleteCommand(input, state.mode);
          if (completed) {
            setInput(completed);
          }
        }
      } else if (e.key === '?' && !e.shiftKey) {
        e.preventDefault();
        // Context-sensitive help
        handleCommand(input + '?');
      } else if (e.key === 'c' && e.ctrlKey) {
        e.preventDefault();
        // Cancel current command
        setOutput(prev => [
          ...prev,
          {
            id: generateId(),
            type: 'input',
            content: input + '^C',
            timestamp: new Date(),
            prompt: currentPrompt(),
          },
        ]);
        setInput('');
        setPasswordMode(false);
      } else if (e.key === 'z' && e.ctrlKey) {
        e.preventDefault();
        // Exit to privileged mode
        if (state.mode !== 'user' && state.mode !== 'privileged') {
          setOutput(prev => [
            ...prev,
            {
              id: generateId(),
              type: 'input',
              content: input + '^Z',
              timestamp: new Date(),
              prompt: currentPrompt(),
            },
          ]);
          setState(prev => ({
            ...prev,
            mode: 'privileged',
            currentInterface: undefined,
            currentLine: undefined,
            currentRouter: undefined,
            currentVlan: undefined,
            currentACL: undefined,
            currentDHCPPool: undefined,
          }));
          setInput('');
        }
      } else if (e.key === 'a' && e.ctrlKey) {
        e.preventDefault();
        inputRef.current?.setSelectionRange(0, 0);
      } else if (e.key === 'e' && e.ctrlKey) {
        e.preventDefault();
        inputRef.current?.setSelectionRange(input.length, input.length);
      } else if (e.key === 'u' && e.ctrlKey) {
        e.preventDefault();
        const cursorPos = inputRef.current?.selectionStart || 0;
        setInput(input.slice(cursorPos));
      } else if (e.key === 'w' && e.ctrlKey) {
        e.preventDefault();
        const cursorPos = inputRef.current?.selectionStart || input.length;
        const beforeCursor = input.slice(0, cursorPos);
        const afterCursor = input.slice(cursorPos);
        const newBefore = beforeCursor.replace(/\S+\s*$/, '');
        setInput(newBefore + afterCursor);
      }
    },
    [input, state, handleCommand, currentPrompt, moreMode, handleMoreKey]
  );

  // Handle click on terminal to focus input
  const handleTerminalClick = useCallback(() => {
    if (!moreMode) {
      inputRef.current?.focus();
    }
  }, [moreMode]);

  // Render output line
  const renderLine = (line: CiscoOutputLine) => {
    const colorClass = {
      input: 'text-white',
      output: 'text-green-400',
      error: 'text-red-400',
      system: 'text-gray-400',
    }[line.type];

    if (line.type === 'input') {
      return (
        <div key={line.id} className="flex">
          <span className="text-green-400 mr-1 whitespace-pre">{line.prompt}</span>
          <span className="text-white whitespace-pre">{line.content}</span>
        </div>
      );
    }

    return (
      <pre key={line.id} className={`${colorClass} whitespace-pre-wrap break-words`}>
        {line.content}
      </pre>
    );
  };

  return (
    <div
      className="h-full w-full bg-black overflow-hidden flex flex-col font-mono text-sm"
      onClick={handleTerminalClick}
    >
      <div
        ref={terminalRef}
        className="flex-1 overflow-y-auto p-3"
        style={{ scrollBehavior: 'smooth' }}
      >
        {output.map(renderLine)}

        {/* --More-- prompt */}
        {moreMode && (
          <div className="text-white">
            <span className="bg-white text-black"> --More-- </span>
            <span className="text-gray-500 ml-2">(Press SPACE for more, Q to quit)</span>
          </div>
        )}

        {/* Command input */}
        {booted && !moreMode && (
          <div className="flex items-center">
            <span className="text-green-400 mr-1 whitespace-pre">{currentPrompt()}</span>
            <input
              ref={inputRef}
              type={passwordMode ? 'password' : 'text'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent text-white outline-none caret-green-400 font-mono"
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

/**
 * Try to complete a partial command
 */
function tryCompleteCommand(partial: string, mode: string): string | null {
  const commands: Record<string, string[]> = {
    user: [
      'connect', 'disable', 'enable', 'exit', 'logout',
      'ping', 'quit', 'show', 'ssh', 'telnet', 'terminal', 'traceroute',
    ],
    privileged: [
      'clear', 'clock', 'configure', 'copy', 'debug', 'delete',
      'dir', 'disable', 'erase', 'exit', 'logout', 'more',
      'ping', 'reload', 'show', 'ssh', 'telnet', 'terminal',
      'traceroute', 'undebug', 'verify', 'write',
    ],
    'global-config': [
      'access-list', 'banner', 'cdp', 'do', 'enable', 'end', 'exit',
      'hostname', 'interface', 'ip', 'line', 'lldp', 'logging',
      'no', 'ntp', 'router', 'service', 'snmp-server',
      'spanning-tree', 'username', 'vlan', 'vtp',
    ],
    interface: [
      'bandwidth', 'description', 'do', 'duplex', 'encapsulation',
      'end', 'exit', 'ip', 'mtu', 'no', 'shutdown',
      'spanning-tree', 'speed', 'switchport',
    ],
    line: [
      'do', 'end', 'exec-timeout', 'exit', 'login',
      'logging', 'no', 'password', 'transport',
    ],
    router: [
      'auto-summary', 'default-information', 'do', 'end', 'exit',
      'network', 'no', 'passive-interface', 'redistribute',
      'router-id', 'version',
    ],
    vlan: ['do', 'end', 'exit', 'mtu', 'name', 'no', 'shutdown', 'state'],
  };

  const modeCommands = commands[mode] || commands['global-config'];
  const matches = modeCommands.filter(cmd => cmd.startsWith(partial.toLowerCase()));

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

export default CiscoTerminal;
