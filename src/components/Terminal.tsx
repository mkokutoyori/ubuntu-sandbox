import React, { useState, useRef, useEffect, useCallback } from 'react';
import { fileSystem } from '@/terminal/filesystem';
import { packageManager } from '@/terminal/packages';
import { executeCommand } from '@/terminal/commands';
import { TerminalState, OutputLine, EditorState } from '@/terminal/types';
import { NanoEditor } from './editors/NanoEditor';
import { VimEditor } from './editors/VimEditor';

const generateId = () => Math.random().toString(36).substr(2, 9);

export const Terminal: React.FC = () => {
  const [state, setState] = useState<TerminalState>({
    currentUser: 'user',
    currentPath: '/home/user',
    hostname: 'ubuntu-terminal',
    history: [],
    historyIndex: -1,
    env: {
      HOME: '/home/user',
      USER: 'user',
      SHELL: '/bin/bash',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      PWD: '/home/user',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
    },
    aliases: {
      'll': 'ls -alF',
      'la': 'ls -A',
      'l': 'ls -CF',
    },
    lastExitCode: 0,
    isRoot: false,
    processes: [],
    backgroundJobs: [],
  });

  const [output, setOutput] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [editorMode, setEditorMode] = useState<EditorState | null>(null);
  const [booted, setBooted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const bootMessages = [
    '[    0.000000] Linux version 5.15.0-generic',
    '[    0.000001] Command line: BOOT_IMAGE=/vmlinuz-5.15.0-generic root=/dev/sda1',
    '[    0.123456] CPU: Intel(R) Core(TM) i7-8565U CPU @ 1.80GHz',
    '[    0.234567] Memory: 16384MB available',
    '[    0.345678] ACPI: Core revision 20210730',
    '[    1.000000] EXT4-fs (sda1): mounted filesystem with ordered data mode',
    '[    1.234567] systemd[1]: Started Session 1 of user user.',
    '',
    'Ubuntu 22.04.3 LTS ubuntu-terminal tty1',
    '',
  ];

  useEffect(() => {
    const bootSequence = async () => {
      for (let i = 0; i < bootMessages.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
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
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    if (booted && !editorMode) {
      inputRef.current?.focus();
    }
  }, [booted, editorMode, output]);

  const getPrompt = useCallback(() => {
    const user = state.currentUser;
    const host = state.hostname;
    const path = state.currentPath === `/home/${user}` ? '~' : 
                 state.currentPath.replace(`/home/${user}`, '~');
    const symbol = state.isRoot || user === 'root' ? '#' : '$';
    return `${user}@${host}:${path}${symbol}`;
  }, [state.currentUser, state.hostname, state.currentPath, state.isRoot]);

  const handleCommand = useCallback((cmd: string) => {
    const prompt = getPrompt();
    
    setOutput(prev => [...prev, {
      id: generateId(),
      type: 'input',
      content: cmd,
      timestamp: new Date(),
      prompt,
    }]);

    if (cmd.trim()) {
      setState(prev => ({
        ...prev,
        history: [...prev.history, cmd],
        historyIndex: -1,
      }));
    }

    const result = executeCommand(cmd, state, fileSystem, packageManager);

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

    if (result.editorMode) {
      setEditorMode(result.editorMode);
    }

    setState(prev => ({
      ...prev,
      currentPath: result.newPath || prev.currentPath,
      currentUser: result.newUser || prev.currentUser,
      isRoot: result.newUser === 'root' || prev.isRoot,
      lastExitCode: result.exitCode,
      env: {
        ...prev.env,
        PWD: result.newPath || prev.currentPath,
        OLDPWD: prev.currentPath,
      },
    }));

    setInput('');
  }, [state, getPrompt]);

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
      // Tab completion
      const parts = input.split(' ');
      const lastPart = parts[parts.length - 1];
      if (lastPart) {
        const dir = lastPart.includes('/') 
          ? fileSystem.resolvePath(lastPart.substring(0, lastPart.lastIndexOf('/')), state.currentPath)
          : state.currentPath;
        const prefix = lastPart.includes('/') ? lastPart.substring(lastPart.lastIndexOf('/') + 1) : lastPart;
        const node = fileSystem.getNode(dir);
        if (node && node.type === 'directory' && node.children) {
          const matches = Array.from(node.children.keys()).filter(name => name.startsWith(prefix));
          if (matches.length === 1) {
            parts[parts.length - 1] = lastPart.includes('/') 
              ? lastPart.substring(0, lastPart.lastIndexOf('/') + 1) + matches[0]
              : matches[0];
            setInput(parts.join(' '));
          }
        }
      }
    } else if (e.key === 'c' && e.ctrlKey) {
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

  const handleEditorSave = useCallback((content: string, filePath: string) => {
    if (filePath) {
      const exists = fileSystem.getNode(filePath);
      if (exists) {
        fileSystem.updateFile(filePath, content);
      } else {
        fileSystem.createNode(filePath, 'file', state.currentUser, content);
      }
    }
    setEditorMode(null);
  }, [state.currentUser]);

  const handleEditorExit = useCallback(() => {
    setEditorMode(null);
  }, []);

  const renderLine = (line: OutputLine) => {
    const colorClass = {
      input: 'text-foreground',
      output: 'text-foreground',
      error: 'text-terminal-red terminal-glow-red',
      system: 'text-terminal-green-dim',
      success: 'text-terminal-green terminal-glow',
    }[line.type];

    if (line.type === 'input') {
      return (
        <div key={line.id} className="flex">
          <span className="text-terminal-amber terminal-glow-amber mr-2">{line.prompt}</span>
          <span className={colorClass}>{line.content}</span>
        </div>
      );
    }

    return (
      <pre key={line.id} className={`${colorClass} whitespace-pre-wrap break-all`}>
        {line.content}
      </pre>
    );
  };

  if (editorMode) {
    if (editorMode.type === 'nano') {
      return <NanoEditor state={editorMode} onSave={handleEditorSave} onExit={handleEditorExit} />;
    }
    return <VimEditor state={editorMode} onSave={handleEditorSave} onExit={handleEditorExit} />;
  }

  return (
    <div 
      className="h-screen w-full bg-background crt-effect terminal-flicker overflow-hidden flex flex-col"
      onClick={() => inputRef.current?.focus()}
    >
      <div className="bg-muted/50 px-4 py-2 flex items-center gap-2 border-b border-border">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-terminal-red" />
          <div className="w-3 h-3 rounded-full bg-terminal-yellow" />
          <div className="w-3 h-3 rounded-full bg-terminal-green" />
        </div>
        <span className="text-muted-foreground text-sm font-mono ml-4">
          {state.currentUser}@{state.hostname}: {state.currentPath}
        </span>
      </div>

      <div 
        ref={terminalRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm scrollbar-terminal"
      >
        {output.map(renderLine)}
        
        {booted && (
          <div className="flex items-center">
            <span className="text-terminal-amber terminal-glow-amber mr-2">{getPrompt()}</span>
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full bg-transparent text-foreground outline-none caret-terminal-green font-mono"
                spellCheck={false}
                autoComplete="off"
                autoFocus
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
