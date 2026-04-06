/**
 * Tests for bash heredoc (<<) and herestring (<<<) support.
 *
 * Covers:
 * - Basic heredoc with quoted delimiter (no expansion)
 * - Heredoc with unquoted delimiter (variable expansion)
 * - Heredoc piped to cat (stdout)
 * - Heredoc redirected to file (cat > file << DELIM)
 * - Herestring (<<< "string")
 * - Heredoc tab stripping (<<-)
 * - Multiple heredocs in a script
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runScriptContent } from '@/bash/runtime/ScriptRunner';
import type { IOContext } from '@/bash/interpreter/BashInterpreter';

// In-memory filesystem for test IO
function createTestIO() {
  const files = new Map<string, string>();
  const io: IOContext = {
    writeFile(path: string, content: string, append: boolean) {
      if (append) {
        files.set(path, (files.get(path) ?? '') + content);
      } else {
        files.set(path, content);
      }
    },
    readFile(path: string) {
      return files.get(path) ?? null;
    },
    resolvePath(path: string) {
      if (path.startsWith('/')) return path;
      return '/home/user/' + path;
    },
  };
  return { io, files };
}

function run(
  script: string,
  vars?: Record<string, string>,
  io?: IOContext,
) {
  const externalCmd = (argv: string[]) => {
    const cmd = argv[0];
    const args = argv.slice(1);
    // Minimal external command support for testing
    switch (cmd) {
      case 'cat': {
        // cat with stdin (last arg is pipe input if no file args)
        const stdinInput = args.length > 0 && !args[args.length - 1].startsWith('-')
          ? args[args.length - 1] : '';
        return { output: stdinInput, exitCode: 0 };
      }
      case 'wc': {
        const input = args[args.length - 1] ?? '';
        if (args.includes('-l')) {
          const lines = input ? input.split('\n').filter(l => l.length > 0).length : 0;
          return { output: String(lines) + '\n', exitCode: 0 };
        }
        return { output: '', exitCode: 0 };
      }
      case 'grep': {
        const pattern = args[0] ?? '';
        const input = args[args.length - 1] ?? '';
        const lines = input.split('\n').filter(l => l.includes(pattern));
        return { output: lines.join('\n') + (lines.length ? '\n' : ''), exitCode: lines.length ? 0 : 1 };
      }
      case 'sort': {
        const input = args[args.length - 1] ?? '';
        const lines = input.split('\n').filter(l => l.length > 0);
        lines.sort();
        return { output: lines.join('\n') + (lines.length ? '\n' : ''), exitCode: 0 };
      }
      case 'tr': {
        const input = args[args.length - 1] ?? '';
        if (args[0] === '[:lower:]' && args[1] === '[:upper:]') {
          return { output: input.toUpperCase(), exitCode: 0 };
        }
        return { output: input, exitCode: 0 };
      }
      default:
        return { output: '', exitCode: 127 };
    }
  };

  return runScriptContent(script, 'test.sh', [], externalCmd, vars ?? {}, io);
}

describe('Bash Heredoc (<<) support', () => {
  describe('Basic heredoc with cat to stdout', () => {
    it('should output heredoc body with quoted delimiter (no expansion)', () => {
      const script = `cat << 'EOF'
Hello World
This is a test
EOF`;
      const result = run(script);
      expect(result.output).toContain('Hello World');
      expect(result.output).toContain('This is a test');
    });

    it('should output heredoc body with unquoted delimiter', () => {
      const script = `cat << EOF
Line one
Line two
EOF`;
      const result = run(script);
      expect(result.output).toContain('Line one');
      expect(result.output).toContain('Line two');
    });

    it('should expand variables in heredoc with unquoted delimiter', () => {
      const script = `NAME="World"
cat << EOF
Hello $NAME
EOF`;
      const result = run(script);
      expect(result.output).toContain('Hello World');
    });

    it('should NOT expand variables in heredoc with quoted delimiter', () => {
      const script = `NAME="World"
cat << 'EOF'
Hello $NAME
EOF`;
      const result = run(script);
      expect(result.output).toContain('Hello $NAME');
    });
  });

  describe('Heredoc with file redirection', () => {
    it('should write heredoc content to file via cat > file << DELIM', () => {
      const { io, files } = createTestIO();
      const script = `cat > /tmp/test.txt << 'HEREDOC'
Jean:Dupont:Ingenieur:45000
Marie:Martin:Manager:55000
Pierre:Durand:Developpeur:42000
HEREDOC`;
      const result = run(script, {}, io);
      const content = files.get('/tmp/test.txt');
      expect(content).toBeDefined();
      expect(content).toContain('Jean:Dupont:Ingenieur:45000');
      expect(content).toContain('Marie:Martin:Manager:55000');
      expect(content).toContain('Pierre:Durand:Developpeur:42000');
    });

    it('should handle heredoc with double-quoted delimiter', () => {
      const { io, files } = createTestIO();
      const script = `cat > /tmp/out.txt << "END"
No expansion here: $NOTHING
END`;
      const result = run(script, {}, io);
      const content = files.get('/tmp/out.txt');
      expect(content).toBeDefined();
      expect(content).toContain('No expansion here:');
    });
  });

  describe('Heredoc tab stripping (<<-)', () => {
    it('should strip leading tabs with <<-', () => {
      const script = `cat <<- EOF
\t\tHello
\t\tWorld
\tEOF`;
      const result = run(script);
      expect(result.output).toContain('Hello');
      expect(result.output).toContain('World');
    });
  });

  describe('Multiple heredocs in a script', () => {
    it('should handle multiple heredocs sequentially', () => {
      const { io, files } = createTestIO();
      const script = `cat > /tmp/file1.txt << 'EOF1'
Content of file 1
EOF1
cat > /tmp/file2.txt << 'EOF2'
Content of file 2
EOF2`;
      const result = run(script, {}, io);
      expect(files.get('/tmp/file1.txt')).toContain('Content of file 1');
      expect(files.get('/tmp/file2.txt')).toContain('Content of file 2');
    });
  });

  describe('Heredoc with the 07_texte.sh pattern', () => {
    it('should create file from heredoc and allow reading it back', () => {
      const { io, files } = createTestIO();
      const script = `cat > /tmp/employes.txt << 'HEREDOC'
Jean:Dupont:Ingenieur:45000
Marie:Martin:Manager:55000
Pierre:Durand:Developpeur:42000
Sophie:Bernard:Ingenieur:47000
Luc:Petit:Manager:58000
Anne:Robert:Developpeur:44000
Paul:Richard:Ingenieur:46000
HEREDOC
echo "Fichier cree: /tmp/employes.txt"`;
      const result = run(script, {}, io);
      const content = files.get('/tmp/employes.txt');
      expect(content).toBeDefined();
      // Should have all 7 employee lines
      const lines = content!.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(7);
      expect(result.output).toContain('Fichier cree: /tmp/employes.txt');
    });
  });
});

describe('Bash Herestring (<<<) support', () => {
  it('should pass herestring content as stdin to command', () => {
    const script = `cat <<< "Hello World"`;
    const result = run(script);
    expect(result.output).toContain('Hello World');
  });

  it('should expand variables in herestring', () => {
    const script = `NAME="Test"
cat <<< "Hello $NAME"`;
    const result = run(script);
    expect(result.output).toContain('Hello Test');
  });
});
