# Linux Terminal

The NetSim Linux terminal provides a realistic bash-like shell simulation with proper shell parsing and command execution.

## Architecture

The shell implementation follows a proper compiler architecture:

```
Input String → Lexer → Tokens → Parser → AST → Executor → Output
```

### Components

1. **Lexer** (`src/terminal/shell/lexer.ts`)
   - Tokenizes shell input into discrete tokens
   - Handles quotes (single/double), escapes, operators
   - Recognizes variables, command substitution, globs

2. **Parser** (`src/terminal/shell/parser.ts`)
   - Builds an Abstract Syntax Tree (AST) from tokens
   - Grammar supports: programs, pipelines, commands, redirections, words

3. **Executor** (`src/terminal/shell/executor.ts`)
   - Executes commands from the AST
   - Properly handles pipes, redirections, and chaining

## Supported Features

### Pipes
```bash
ls | grep foo | wc -l
echo "hello" | cat
cat file.txt | sort | uniq
```

### Redirections
```bash
echo "content" > file.txt        # Output redirection
echo "more" >> file.txt          # Append redirection
cat < input.txt                  # Input redirection
command 2> errors.txt            # Stderr redirection
command 2>&1                     # Stderr to stdout
```

### Combined Pipes and Redirections
```bash
# The parser correctly handles complex cases like:
echo "print('hello')" >> script.py | python script.py
cat file.txt | grep pattern > output.txt
```

### Command Chaining
```bash
cd /tmp && ls                    # Run ls if cd succeeds
test -f file || echo "missing"   # Run echo if test fails
echo "first"; echo "second"      # Sequential execution
```

### Quotes
```bash
echo "double quotes allow $VAR"  # Variable expansion
echo 'single quotes are literal' # No expansion
echo "nested 'quotes' work"
```

### Variables
```bash
echo $HOME                       # Simple variable
echo ${HOME}                     # Braced variable
VAR=value                        # Variable assignment
echo "Path: $PATH"
```

### Command Substitution
```bash
echo "Today is $(date)"
echo `uname -a`
```

### Globs
```bash
ls *.txt
rm -rf /tmp/*
cat file?.log
```

### Background Jobs
```bash
sleep 10 &
```

## Pipe-Compatible Commands

These commands properly handle piped input:

| Command | Example |
|---------|---------|
| `grep` | `echo "foo\nbar" \| grep foo` |
| `wc` | `cat file \| wc -l` |
| `head` | `cat file \| head -n 5` |
| `tail` | `cat file \| tail -n 5` |
| `sort` | `cat file \| sort` |
| `uniq` | `cat file \| sort \| uniq` |
| `tr` | `echo "ABC" \| tr 'A-Z' 'a-z'` |
| `cut` | `echo "a:b:c" \| cut -d: -f2` |
| `awk` | `cat file \| awk '{print $1}'` |
| `sed` | `echo "foo" \| sed 's/foo/bar/'` |
| `tee` | `echo "test" \| tee file.txt` |
| `xargs` | `ls \| xargs rm` |
| `cat` | `echo "test" \| cat` |
| `rev` | `echo "hello" \| rev` |
| `nl` | `cat file \| nl` |

## Available Commands

The terminal includes 100+ Linux commands organized by category:

### Navigation
- `cd`, `pwd`, `pushd`, `popd`, `dirs`

### File Operations
- `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`
- `head`, `tail`, `more`, `less`
- `chmod`, `chown`, `chgrp`
- `ln`, `readlink`, `stat`, `file`
- `find`, `locate`, `which`, `whereis`

### Text Processing
- `grep`, `sed`, `awk`, `cut`, `sort`, `uniq`
- `tr`, `wc`, `diff`, `comm`
- `echo`, `printf`

### System
- `uname`, `hostname`, `uptime`, `date`
- `whoami`, `id`, `groups`
- `ps`, `top`, `kill`, `jobs`
- `df`, `du`, `free`
- `env`, `export`, `set`, `unset`

### Package Management
- `apt`, `apt-get`, `apt-cache`
- `dpkg`

### Network
- `ping`, `traceroute`, `netstat`, `ss`
- `ip`, `ifconfig`, `route`
- `curl`, `wget`
- `ssh`, `scp`
- `nslookup`, `dig`, `host`

### Archive
- `tar`, `gzip`, `gunzip`, `zip`, `unzip`

### User Management
- `useradd`, `userdel`, `usermod`
- `passwd`, `su`, `sudo`

## Extending the Terminal

To add new commands:

1. Create a command function in the appropriate module under `src/terminal/commands/`:

```typescript
export const myCommand: CommandFunction = (args, state, fs, pm, stdin) => {
  // args: command arguments
  // state: terminal state (currentPath, currentUser, env, etc.)
  // fs: FileSystem instance
  // pm: PackageManager instance
  // stdin: piped input (if any)

  return {
    output: 'command output',
    exitCode: 0,
    error: undefined  // or error message
  };
};
```

2. Register the command in the appropriate registry (e.g., `fileCommands`, `systemCommands`).

3. If the command handles stdin, add special handling in `executor.ts` `executeWithPipedInput()`.

## Tests

Shell tests are located in `src/__tests__/Shell.test.ts` and cover:
- Lexer tokenization
- Parser AST generation
- Executor command execution
- Pipe handling
- Redirection handling
- Command chaining

Run tests with:
```bash
npm test -- --run src/__tests__/Shell.test.ts
```
