/**
 * CiscoTerminal - Cisco IOS Terminal Emulation
 *
 * Realistic Cisco CLI with boot sequence, banners, and IOS commands.
 * Uses the actual CiscoRouter/CiscoSwitch domain classes.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BaseDevice } from '@/domain/devices';
import { CiscoRouter } from '@/domain/devices/CiscoRouter';
import { CiscoSwitch } from '@/domain/devices/CiscoSwitch';

interface CiscoOutputLine {
  id: string;
  text: string;
  type: 'normal' | 'error' | 'warning' | 'boot';
  timestamp: number;
}

interface CiscoTerminalProps {
  device?: BaseDevice;
  deviceType?: 'router' | 'switch';
  hostname?: string;
  onRequestClose?: () => void;
}

let lineIdCounter = 0;
const generateId = () => `cisco-line-${++lineIdCounter}-${Date.now()}`;

export const CiscoTerminal: React.FC<CiscoTerminalProps> = ({
  device,
  deviceType = 'router',
  hostname,
  onRequestClose,
}) => {
  const [output, setOutput] = useState<CiscoOutputLine[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isBooting, setIsBooting] = useState(true);
  const [bootComplete, setBootComplete] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Get the Cisco device instance
  const ciscoDevice = useMemo(() => {
    if (device) {
      // Check if it's a Cisco device
      if (device instanceof CiscoRouter || device instanceof CiscoSwitch) {
        return device;
      }
      // Check by type
      const type = device.getType();
      if (type === 'cisco-router' || type === 'cisco-switch') {
        return device as CiscoRouter | CiscoSwitch;
      }
    }
    return null;
  }, [device]);

  // Get hostname from device or prop
  const displayHostname = useMemo(() => {
    if (ciscoDevice) {
      return ciscoDevice.getHostname();
    }
    return hostname || (deviceType === 'switch' ? 'Switch' : 'Router');
  }, [ciscoDevice, hostname, deviceType]);

  // Get prompt from device or generate one
  const prompt = useMemo(() => {
    if (ciscoDevice && 'getPrompt' in ciscoDevice) {
      return (ciscoDevice as any).getPrompt();
    }
    return `${displayHostname}>`;
  }, [ciscoDevice, displayHostname]);

  // Scroll to bottom when output changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  // Focus input on mount
  useEffect(() => {
    if (!isBooting) {
      inputRef.current?.focus();
    }
  }, [isBooting]);

  // Display boot sequence on mount
  useEffect(() => {
    if (bootComplete) return;

    const showBootSequence = async () => {
      setIsBooting(true);

      let bootSequence = '';

      if (ciscoDevice && 'getBootSequence' in ciscoDevice) {
        bootSequence = (ciscoDevice as any).getBootSequence();
      } else {
        // Fallback boot sequence
        bootSequence = deviceType === 'switch'
          ? getDefaultSwitchBootSequence(displayHostname)
          : getDefaultRouterBootSequence(displayHostname);
      }

      // Split boot sequence into lines and display with animation
      const lines = bootSequence.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Add line with small delay for animation effect
        await new Promise(resolve => setTimeout(resolve, 15));

        setOutput(prev => [...prev, {
          id: generateId(),
          text: line,
          type: 'boot',
          timestamp: Date.now(),
        }]);
      }

      // Show banner if available
      if (ciscoDevice && 'getBanner' in ciscoDevice) {
        const motd = (ciscoDevice as any).getBanner('motd');
        if (motd) {
          setOutput(prev => [...prev, {
            id: generateId(),
            text: `\n${motd}\n`,
            type: 'normal',
            timestamp: Date.now(),
          }]);
        }
      }

      // Add empty line before prompt
      setOutput(prev => [...prev, {
        id: generateId(),
        text: '',
        type: 'normal',
        timestamp: Date.now(),
      }]);

      setIsBooting(false);
      setBootComplete(true);

      // Focus input after boot
      setTimeout(() => inputRef.current?.focus(), 100);
    };

    showBootSequence();
  }, [ciscoDevice, deviceType, displayHostname, bootComplete]);

  // Append a line to output
  const appendLine = useCallback((text: string, type: CiscoOutputLine['type'] = 'normal') => {
    setOutput(prev => [...prev, {
      id: generateId(),
      text,
      type,
      timestamp: Date.now(),
    }]);
  }, []);

  // Execute command
  const runCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();

    // Echo the command with prompt
    appendLine(`${prompt}${cmd}`);

    // Handle exit at user mode
    if ((trimmed === 'exit' || trimmed === 'logout')) {
      if (ciscoDevice) {
        const result = await ciscoDevice.executeCommand(trimmed);
        if (result === 'Connection closed.' || result === '') {
          onRequestClose?.();
          return;
        }
      } else {
        onRequestClose?.();
        return;
      }
    }

    // Add to history
    if (trimmed) {
      setHistory(prev => [...prev.slice(-99), trimmed]);
      setHistoryIndex(-1);
    }

    // Execute command on device
    if (ciscoDevice) {
      try {
        const result = await ciscoDevice.executeCommand(trimmed);
        if (result) {
          appendLine(result);
        }
      } catch (error) {
        appendLine(`% Error: ${error}`, 'error');
      }
    } else {
      // Fallback for when no device instance is provided
      appendLine('% Device not connected', 'error');
    }

    setInput('');
  }, [appendLine, ciscoDevice, onRequestClose, prompt]);

  // Handle keyboard input
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      runCommand(input);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInput(history[newIndex] ?? '');
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        setHistoryIndex(newIndex);
        setInput(history[newIndex] ?? '');
      }
      return;
    }

    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      appendLine(`${prompt}${input}^C`, 'warning');
      setInput('');
    }

    // Tab completion hint
    if (e.key === 'Tab') {
      e.preventDefault();
      if (input.endsWith('?')) {
        runCommand(input);
      } else {
        // Show available commands hint
        appendLine(`${prompt}${input}?`);
        runCommand(input + '?');
      }
    }
  }, [appendLine, history, historyIndex, input, prompt, runCommand]);

  return (
    <div className="h-full w-full bg-black text-green-400 flex flex-col font-mono text-sm">
      {/* Terminal header */}
      <div className="border-b border-green-900/50 px-3 py-2 text-xs text-green-600 bg-black/50">
        Cisco IOS — {displayHostname} {deviceType === 'switch' ? '(C2960)' : '(C2911)'}
      </div>

      {/* Terminal output area */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 space-y-0 bg-black"
        onClick={() => !isBooting && inputRef.current?.focus()}
      >
        {output.map((line) => (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap leading-5 ${
              line.type === 'error' ? 'text-red-400' :
              line.type === 'warning' ? 'text-yellow-400' :
              line.type === 'boot' ? 'text-green-500' :
              'text-green-400'
            }`}
          >
            {line.text}
          </pre>
        ))}

        {/* Input line - only show when not booting */}
        {!isBooting && (
          <div className="flex items-center">
            <span className="text-green-400 whitespace-pre">{prompt}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none text-green-400 caret-green-400"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </div>
        )}

        {/* Booting indicator */}
        {isBooting && (
          <div className="flex items-center text-green-500">
            <span className="animate-pulse">█</span>
          </div>
        )}
      </div>
    </div>
  );
};

// Default boot sequences when no device instance is available
function getDefaultRouterBootSequence(hostname: string): string {
  return `
System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 2010 by cisco Systems, Inc.

Initializing memory for ECC

BOOTLDR: C2900 Boot Loader (C2900-HBOOT-M) Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)

           cisco Systems, Inc.
           170 West Tasman Drive
           San Jose, California 95134-1706

Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc1)
Copyright (c) 1986-2012 by Cisco Systems, Inc.

cisco C2911 (revision 1.0) processor with 491520K/32768K bytes of memory.
Processor board ID FTX152400KS
3 Gigabit Ethernet interfaces
255K bytes of non-volatile configuration memory.
249856K bytes of ATA System CompactFlash 0 (Read/Write)

Press RETURN to get started!
`;
}

function getDefaultSwitchBootSequence(hostname: string): string {
  return `
System Bootstrap, Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 2013 by cisco Systems, Inc.

Initializing memory...

BOOTLDR: C2960 Boot Loader (C2960-HBOOT-M) Version 12.2(53r)SEY3, RELEASE SOFTWARE (fc1)

           cisco Systems, Inc.
           170 West Tasman Drive
           San Jose, California 95134-1706

Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)
Copyright (c) 1986-2013 by Cisco Systems, Inc.

cisco WS-C2960-24TT-L (PowerPC405) processor with 65536K bytes of memory.
Processor board ID FOC1010X104
24 FastEthernet interfaces
2 Gigabit Ethernet interfaces
64K bytes of flash-simulated non-volatile configuration memory.

Press RETURN to get started!
`;
}

export default CiscoTerminal;
