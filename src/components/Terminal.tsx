import React, { useState, useRef, useEffect, useCallback } from 'react';
import { fileSystem } from '@/terminal/filesystem';
import { packageManager } from '@/terminal/packages';
import { executeCommand, commands } from '@/terminal/commands';
import { TerminalState, OutputLine, EditorState } from '@/terminal/types';
import { NanoEditor } from './editors/NanoEditor';
import { VimEditor } from './editors/VimEditor';
import { parseAnsi } from '@/terminal/ansiParser';
import {
  getCommandCompletions,
  getPathCompletions,
  searchHistory,
  ACHIEVEMENTS,
  Achievement,
  CommandStats,
  TUTORIAL_STEPS,
  TutorialStep,
} from '@/terminal/shellUtils';
import { createPythonSession, executeLine, PythonSession, PythonContext } from '@/terminal/python';
import { createOrGetSQLPlusSession, deleteSQLPlusSession } from '@/terminal/commands/database';
import { executeSQLPlus, getSQLPlusPrompt } from '@/terminal/sql/oracle/sqlplus';

const generateId = () => Math.random().toString(36).substr(2, 9);

// LocalStorage keys
const STORAGE_KEYS = {
  HISTORY: 'terminal_history',
  ACHIEVEMENTS: 'terminal_achievements',
  STATS: 'terminal_stats',
  VARIABLES: 'terminal_variables',
};

// Load from localStorage
function loadFromStorage<T>(key: string, defaultValue: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error(`Error loading ${key} from storage:`, e);
  }
  return defaultValue;
}

// Save to localStorage
function saveToStorage(key: string, value: any): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`Error saving ${key} to storage:`, e);
  }
}

interface TerminalProps {
  onRequestClose?: () => void;
}

export const Terminal: React.FC<TerminalProps> = ({ onRequestClose }) => {
  // Load history from localStorage
  const savedHistory = loadFromStorage<string[]>(STORAGE_KEYS.HISTORY, []);
  const savedAchievements = loadFromStorage<string[]>(STORAGE_KEYS.ACHIEVEMENTS, []);
  const savedVariables = loadFromStorage<Record<string, string>>(STORAGE_KEYS.VARIABLES, {});

  const [state, setState] = useState<TerminalState>({
    currentUser: 'user',
    currentPath: '/home/user',
    hostname: 'ubuntu-terminal',
    history: savedHistory,
    historyIndex: -1,
    env: {
      HOME: '/home/user',
      USER: 'user',
      SHELL: '/bin/bash',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      PWD: '/home/user',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      ...savedVariables,
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
  const [cursorPosition, setCursorPosition] = useState(0);

  // Auto-suggestions
  const [suggestion, setSuggestion] = useState('');
  const [showCompletions, setShowCompletions] = useState(false);
  const [completions, setCompletions] = useState<string[]>([]);

  // History search mode (Ctrl+R)
  const [historySearchMode, setHistorySearchMode] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [historySearchResults, setHistorySearchResults] = useState<string[]>([]);
  const [historySearchIndex, setHistorySearchIndex] = useState(0);

  // Tutorial mode
  const [tutorialMode, setTutorialMode] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);

  // Python REPL mode
  const [pythonMode, setPythonMode] = useState(false);
  const [pythonPrompt, setPythonPrompt] = useState('>>> ');
  const [pythonSession, setPythonSession] = useState<PythonSession | null>(null);

  // SQL*Plus mode
  const [sqlplusMode, setSqlplusMode] = useState(false);
  const [sqlplusPrompt, setSqlplusPrompt] = useState('SQL> ');

  // Achievements
  const [achievements, setAchievements] = useState<string[]>(savedAchievements);
  const [newAchievement, setNewAchievement] = useState<Achievement | null>(null);
  const [stats, setStats] = useState<CommandStats>({
    commandsExecuted: 0,
    uniqueCommands: new Set<string>(),
    filesCreated: 0,
    filesDeleted: 0,
    directoriesCreated: 0,
    pipesUsed: 0,
    sudoUsed: 0,
    errorsEncountered: 0,
    sessionStart: new Date(),
  });

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
    'Type "tutorial" to start the interactive tutorial, or "achievements" to see your progress.',
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

  // Save history to localStorage when it changes
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.HISTORY, state.history.slice(-1000)); // Keep last 1000 commands
  }, [state.history]);

  // Save achievements to localStorage
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.ACHIEVEMENTS, achievements);
  }, [achievements]);

  // Check for new achievements
  useEffect(() => {
    ACHIEVEMENTS.forEach(achievement => {
      if (!achievements.includes(achievement.id) && achievement.condition(stats)) {
        setAchievements(prev => [...prev, achievement.id]);
        setNewAchievement(achievement);
        setTimeout(() => setNewAchievement(null), 5000);
      }
    });
  }, [stats, achievements]);

  // Auto-suggestions based on history
  useEffect(() => {
    if (input && !historySearchMode) {
      const match = state.history
        .slice()
        .reverse()
        .find(cmd => cmd.startsWith(input) && cmd !== input);
      setSuggestion(match ? match.slice(input.length) : '');
    } else {
      setSuggestion('');
    }
  }, [input, state.history, historySearchMode]);

  const getPrompt = useCallback(() => {
    // Python REPL prompt
    if (pythonMode) {
      return pythonPrompt;
    }

    // SQL*Plus prompt
    if (sqlplusMode) {
      return sqlplusPrompt;
    }

    const user = state.currentUser;
    const host = state.hostname;
    const path = state.currentPath === `/home/${user}` ? '~' :
                 state.currentPath.replace(`/home/${user}`, '~');
    const symbol = state.isRoot || user === 'root' ? '#' : '$';
    return `${user}@${host}:${path}${symbol}`;
  }, [state.currentUser, state.hostname, state.currentPath, state.isRoot, pythonMode, pythonPrompt, sqlplusMode, sqlplusPrompt]);

  const updateStats = useCallback((cmd: string, result: any) => {
    setStats(prev => {
      const newStats = { ...prev };
      newStats.commandsExecuted++;
      newStats.uniqueCommands = new Set([...prev.uniqueCommands, cmd.split(' ')[0]]);

      if (cmd.includes('|')) newStats.pipesUsed++;
      if (cmd.startsWith('sudo')) newStats.sudoUsed++;
      if (result.error) newStats.errorsEncountered++;
      if (cmd.startsWith('touch') || cmd.includes('> ')) newStats.filesCreated++;
      if (cmd.startsWith('rm ')) newStats.filesDeleted++;
      if (cmd.startsWith('mkdir')) newStats.directoriesCreated++;

      return newStats;
    });
  }, []);

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

    // Handle Python REPL mode - directly call Python interpreter to preserve quotes
    if (pythonMode) {
      // Initialize session if needed
      let session = pythonSession;
      if (!session) {
        const context: PythonContext = {
          filesystem: fileSystem,
          currentPath: state.currentPath,
          terminalState: state
        };
        session = createPythonSession(context);
        setPythonSession(session);
      }
      // Update current path in session context
      session.context.currentPath = state.currentPath;

      // Execute Python code directly (bypassing shell parser to preserve quotes)
      const result = executeLine(session, cmd);

      if (result.exit) {
        setPythonMode(false);
        setPythonPrompt('>>> ');
        setPythonSession(null);
        setInput('');
        return;
      }

      if (result.prompt) {
        setPythonPrompt(result.prompt);
      }

      if (result.output) {
        setOutput(prev => [...prev, {
          id: generateId(),
          type: 'output',
          content: result.output,
          timestamp: new Date(),
        }]);
      }

      setInput('');
      return;
    }

    // Handle SQL*Plus mode
    if (sqlplusMode) {
      const sessionId = state.currentUser;
      const session = createOrGetSQLPlusSession(sessionId);
      const result = executeSQLPlus(session, cmd);

      if (result.exit) {
        setSqlplusMode(false);
        setSqlplusPrompt('SQL> ');
        deleteSQLPlusSession(sessionId);
        setOutput(prev => [...prev, {
          id: generateId(),
          type: 'system',
          content: 'Disconnected from Oracle Database.',
          timestamp: new Date(),
        }]);
        setInput('');
        return;
      }

      // Build output
      let outputText = '';
      if (result.output) {
        outputText += result.output;
      }
      if (result.error) {
        outputText += (outputText ? '\n' : '') + result.error;
      }
      if (result.feedback) {
        outputText += (outputText ? '\n' : '') + result.feedback;
      }

      if (outputText) {
        setOutput(prev => [...prev, {
          id: generateId(),
          type: result.error ? 'error' : 'output',
          content: outputText,
          timestamp: new Date(),
        }]);
      }

      // Update prompt
      setSqlplusPrompt(getSQLPlusPrompt(session));
      setInput('');
      return;
    }

    // Handle special commands
    if (cmd.trim() === 'exit' || cmd.trim() === 'logout') {
      if (onRequestClose) {
        onRequestClose();
        return;
      }
      // If no close handler, just show a message
      setOutput(prev => [...prev, {
        id: generateId(),
        type: 'system',
        content: 'logout',
        timestamp: new Date(),
      }]);
      setInput('');
      return;
    }

    if (cmd.trim() === 'tutorial') {
      setTutorialMode(true);
      setTutorialStep(0);
      const step = TUTORIAL_STEPS[0];
      setOutput(prev => [...prev, {
        id: generateId(),
        type: 'system',
        content: `\n=== TUTORIEL: ${step.title} ===\n${step.description}\n\nCommande: ${step.command}\nAstuce: ${step.hint}\n`,
        timestamp: new Date(),
      }]);
      setInput('');
      return;
    }

    if (cmd.trim() === 'achievements') {
      const unlockedAchievements = ACHIEVEMENTS.filter(a => achievements.includes(a.id));
      const lockedAchievements = ACHIEVEMENTS.filter(a => !achievements.includes(a.id));

      let output = '\n=== ACHIEVEMENTS ===\n\n';
      output += `Débloqués (${unlockedAchievements.length}/${ACHIEVEMENTS.length}):\n`;
      unlockedAchievements.forEach(a => {
        output += `  ${a.icon} ${a.name} - ${a.description}\n`;
      });
      output += '\nVerrouillés:\n';
      lockedAchievements.forEach(a => {
        output += `  🔒 ${a.name} - ${a.description}\n`;
      });
      output += `\nStatistiques:\n`;
      output += `  Commandes exécutées: ${stats.commandsExecuted}\n`;
      output += `  Commandes uniques: ${stats.uniqueCommands.size}\n`;
      output += `  Pipes utilisés: ${stats.pipesUsed}\n`;

      setOutput(prev => [...prev, {
        id: generateId(),
        type: 'output',
        content: output,
        timestamp: new Date(),
      }]);
      setInput('');
      return;
    }

    // Tutorial mode validation
    if (tutorialMode && tutorialStep < TUTORIAL_STEPS.length) {
      const step = TUTORIAL_STEPS[tutorialStep];
      if (step.validator(cmd, '')) {
        const nextStep = tutorialStep + 1;
        if (nextStep < TUTORIAL_STEPS.length) {
          setTutorialStep(nextStep);
          const next = TUTORIAL_STEPS[nextStep];
          setTimeout(() => {
            setOutput(prev => [...prev, {
              id: generateId(),
              type: 'success',
              content: `\n✓ Correct!\n\n=== TUTORIEL: ${next.title} ===\n${next.description}\n\nCommande: ${next.command}\nAstuce: ${next.hint}\n`,
              timestamp: new Date(),
            }]);
          }, 500);
        } else {
          setTutorialMode(false);
          setTimeout(() => {
            setOutput(prev => [...prev, {
              id: generateId(),
              type: 'success',
              content: '\n🎉 Félicitations ! Vous avez terminé le tutoriel !\n',
              timestamp: new Date(),
            }]);
          }, 500);
        }
      }
    }

    const result = executeCommand(cmd, state, fileSystem, packageManager);

    // Update stats
    updateStats(cmd, result);

    // Handle environment variable updates
    if ((result as any).envUpdate) {
      setState(prev => ({
        ...prev,
        env: { ...prev.env, ...(result as any).envUpdate },
      }));
      saveToStorage(STORAGE_KEYS.VARIABLES, { ...state.env, ...(result as any).envUpdate });
    }

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

    // Check if we're entering Python mode
    if ((result as any).enterPythonMode) {
      setPythonMode(true);
      setPythonPrompt('>>> ');
      const context: PythonContext = {
        filesystem: fileSystem,
        currentPath: state.currentPath,
        terminalState: state
      };
      setPythonSession(createPythonSession(context));
    }

    // Check if we're entering SQL*Plus mode
    if ((result as any).enterSQLPlusMode) {
      setSqlplusMode(true);
      setSqlplusPrompt('SQL> ');
      // Create session
      createOrGetSQLPlusSession(state.currentUser);
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
        '?': result.exitCode.toString(),
      },
    }));

    setInput('');
    setSuggestion('');
    setShowCompletions(false);
  }, [state, getPrompt, tutorialMode, tutorialStep, achievements, stats, updateStats, pythonMode, pythonSession, sqlplusMode, onRequestClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // History search mode
    if (historySearchMode) {
      if (e.key === 'Escape') {
        setHistorySearchMode(false);
        setHistorySearchQuery('');
        return;
      }
      if (e.key === 'Enter') {
        if (historySearchResults[historySearchIndex]) {
          setInput(historySearchResults[historySearchIndex]);
        }
        setHistorySearchMode(false);
        setHistorySearchQuery('');
        return;
      }
      if (e.key === 'ArrowUp' || (e.key === 'r' && e.ctrlKey)) {
        e.preventDefault();
        setHistorySearchIndex(prev => Math.min(prev + 1, historySearchResults.length - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHistorySearchIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      return;
    }

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
      e.stopPropagation();

      // In Python mode, Tab inserts 4 spaces for indentation
      if (pythonMode) {
        const cursorPos = inputRef.current?.selectionStart || input.length;
        const newInput = input.slice(0, cursorPos) + '    ' + input.slice(cursorPos);
        setInput(newInput);
        // Set cursor position after the inserted spaces
        setTimeout(() => {
          inputRef.current?.setSelectionRange(cursorPos + 4, cursorPos + 4);
        }, 0);
        return;
      }

      // Accept auto-suggestion with Tab
      if (suggestion) {
        setInput(input + suggestion);
        setSuggestion('');
        return;
      }

      const parts = input.split(' ');
      const lastPart = parts[parts.length - 1];

      // Command completion (first word)
      if (parts.length === 1) {
        const cmdCompletions = getCommandCompletions(lastPart);
        if (cmdCompletions.length === 1) {
          setInput(cmdCompletions[0] + ' ');
          setShowCompletions(false);
        } else if (cmdCompletions.length > 1) {
          setCompletions(cmdCompletions);
          setShowCompletions(true);
        }
        return;
      }

      // Path completion
      const pathCompletions = getPathCompletions(lastPart, state.currentPath, fileSystem);

      if (pathCompletions.length === 1) {
        parts[parts.length - 1] = pathCompletions[0];
        setInput(parts.join(' '));
        setShowCompletions(false);
      } else if (pathCompletions.length > 1) {
        // Find common prefix
        let commonPrefix = pathCompletions[0];
        for (const completion of pathCompletions) {
          while (!completion.startsWith(commonPrefix)) {
            commonPrefix = commonPrefix.slice(0, -1);
          }
        }
        if (commonPrefix.length > lastPart.length) {
          parts[parts.length - 1] = commonPrefix;
          setInput(parts.join(' '));
        }
        setCompletions(pathCompletions);
        setShowCompletions(true);
      }
    } else if (e.key === 'ArrowRight') {
      // Accept suggestion with Right Arrow at end of input
      if (suggestion && inputRef.current?.selectionStart === input.length) {
        e.preventDefault();
        setInput(input + suggestion);
        setSuggestion('');
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
      setSuggestion('');
      setHistorySearchMode(false);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setOutput([]);
    } else if (e.key === 'a' && e.ctrlKey) {
      // Go to beginning of line
      e.preventDefault();
      inputRef.current?.setSelectionRange(0, 0);
    } else if (e.key === 'e' && e.ctrlKey) {
      // Go to end of line
      e.preventDefault();
      inputRef.current?.setSelectionRange(input.length, input.length);
    } else if (e.key === 'w' && e.ctrlKey) {
      // Delete word backward
      e.preventDefault();
      const cursorPos = inputRef.current?.selectionStart || input.length;
      const beforeCursor = input.slice(0, cursorPos);
      const afterCursor = input.slice(cursorPos);
      const newBefore = beforeCursor.replace(/\S+\s*$/, '');
      setInput(newBefore + afterCursor);
      setTimeout(() => inputRef.current?.setSelectionRange(newBefore.length, newBefore.length), 0);
    } else if (e.key === 'u' && e.ctrlKey) {
      // Delete from cursor to beginning
      e.preventDefault();
      const cursorPos = inputRef.current?.selectionStart || 0;
      setInput(input.slice(cursorPos));
      setTimeout(() => inputRef.current?.setSelectionRange(0, 0), 0);
    } else if (e.key === 'k' && e.ctrlKey) {
      // Delete from cursor to end
      e.preventDefault();
      const cursorPos = inputRef.current?.selectionStart || input.length;
      setInput(input.slice(0, cursorPos));
    } else if (e.key === 'r' && e.ctrlKey) {
      // Reverse history search
      e.preventDefault();
      setHistorySearchMode(true);
      setHistorySearchQuery('');
      setHistorySearchResults(state.history.slice().reverse());
      setHistorySearchIndex(0);
    } else if (e.key === 'd' && e.ctrlKey) {
      // Exit Python mode, SQL*Plus mode, or logout
      e.preventDefault();
      if (input === '') {
        if (pythonMode) {
          setPythonMode(false);
          setPythonPrompt('>>> ');
          setPythonSession(null);
          setOutput(prev => [...prev, {
            id: generateId(),
            type: 'system',
            content: '',
            timestamp: new Date(),
          }]);
        } else if (sqlplusMode) {
          setSqlplusMode(false);
          setSqlplusPrompt('SQL> ');
          deleteSQLPlusSession(state.currentUser);
          setOutput(prev => [...prev, {
            id: generateId(),
            type: 'system',
            content: 'Disconnected from Oracle Database.',
            timestamp: new Date(),
          }]);
        } else {
          setOutput(prev => [...prev, {
            id: generateId(),
            type: 'system',
            content: 'logout',
            timestamp: new Date(),
          }]);
        }
      }
    } else if (e.key === 'Escape') {
      setShowCompletions(false);
      setSuggestion('');
    } else {
      setShowCompletions(false);
    }
  }, [input, state, handleCommand, getPrompt, suggestion, historySearchMode, historySearchResults, historySearchIndex, pythonMode, sqlplusMode]);

  // Handle history search input
  const handleHistorySearchInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setHistorySearchQuery(query);
    const results = searchHistory(state.history, query);
    setHistorySearchResults(results);
    setHistorySearchIndex(0);
  }, [state.history]);

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

  // Render ANSI-formatted text with proper styling
  const renderAnsiText = (text: string, key?: string) => {
    const segments = parseAnsi(text);

    return (
      <>
        {segments.map((segment, index) => {
          const hasStyles = Object.keys(segment.styles).length > 0;
          if (!hasStyles) {
            return <span key={`${key}-${index}`}>{segment.text}</span>;
          }
          return (
            <span key={`${key}-${index}`} style={segment.styles}>
              {segment.text}
            </span>
          );
        })}
      </>
    );
  };

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
          <span className="text-terminal-amber terminal-glow-amber mr-2 whitespace-pre">{line.prompt}</span>
          <span className={`${colorClass} whitespace-pre`}>{line.content}</span>
        </div>
      );
    }

    return (
      <pre key={line.id} className={`${colorClass} whitespace-pre-wrap break-all`}>
        {renderAnsiText(line.content, line.id)}
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
      {/* Achievement notification */}
      {newAchievement && (
        <div className="fixed top-4 right-4 bg-terminal-green/20 border border-terminal-green p-4 rounded-lg animate-pulse z-50">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{newAchievement.icon}</span>
            <div>
              <div className="text-terminal-green font-bold">Achievement Débloqué!</div>
              <div className="text-terminal-green">{newAchievement.name}</div>
              <div className="text-terminal-green-dim text-sm">{newAchievement.description}</div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-muted/50 px-4 py-2 flex items-center gap-2 border-b border-border">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-terminal-red" />
          <div className="w-3 h-3 rounded-full bg-terminal-yellow" />
          <div className="w-3 h-3 rounded-full bg-terminal-green" />
        </div>
        <span className="text-muted-foreground text-sm font-mono ml-4">
          {state.currentUser}@{state.hostname}: {state.currentPath}
        </span>
        {tutorialMode && (
          <span className="ml-auto text-terminal-amber text-sm">
            📚 Tutorial ({tutorialStep + 1}/{TUTORIAL_STEPS.length})
          </span>
        )}
        {pythonMode && (
          <span className="ml-auto text-terminal-green text-sm">
            🐍 Python 3.11 REPL (exit() or Ctrl+D to exit)
          </span>
        )}
        {sqlplusMode && (
          <span className="ml-auto text-terminal-amber text-sm">
            🗄️ SQL*Plus 21.0 (EXIT or QUIT to exit)
          </span>
        )}
      </div>

      <div
        ref={terminalRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm scrollbar-terminal"
      >
        {output.map(renderLine)}

        {/* History search mode */}
        {historySearchMode && (
          <div className="flex items-center text-terminal-amber">
            <span>(reverse-i-search)`</span>
            <input
              type="text"
              value={historySearchQuery}
              onChange={handleHistorySearchInput}
              className="bg-transparent text-terminal-amber outline-none w-32"
              autoFocus
            />
            <span>': {historySearchResults[historySearchIndex] || ''}</span>
          </div>
        )}

        {booted && !historySearchMode && (
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
              {/* Auto-suggestion overlay */}
              {suggestion && (
                <span className="absolute left-0 top-0 text-muted-foreground pointer-events-none">
                  <span className="invisible">{input}</span>
                  <span className="text-muted-foreground/50">{suggestion}</span>
                </span>
              )}
            </div>
          </div>
        )}

        {/* Tab completion suggestions */}
        {showCompletions && completions.length > 0 && (
          <div className="text-muted-foreground mt-1 flex flex-wrap gap-4">
            {completions.map((c, i) => (
              <span key={i} className="text-terminal-cyan">{c}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
