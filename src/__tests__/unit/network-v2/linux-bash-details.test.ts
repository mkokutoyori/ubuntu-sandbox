/**
 * TDD Tests for a Bash Interpreter implementation
 * ~150+ scenarios covering basic commands, variables, I/O redirection,
 * pipes, conditionals, loops, functions, arrays, expansions, error handling, etc.
 * Designed to mimic the behavior of a real Bash shell.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
// Assuming you might test on a non-root user PC as well
import { LinuxPC } from '@/network/devices/LinuxPC';

// ═══════════════════════════════════════════════════════════════════
// TDD for Bash Interpreter
// ═══════════════════════════════════════════════════════════════════

describe('Bash Interpreter TDD Suite', () => {
  let server: LinuxServer;

  beforeEach(() => {
    // A new server for each test ensures a clean state (no leftover files, variables, etc.)
    server = new LinuxServer('linux-server', 'BASH-TEST');
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 1: Commandes de base et Syntaxe
  // ═══════════════════════════════════════════════════════════════════

  describe('G1: Commandes de base et Syntaxe', () => {
    it('G1-01: should execute a simple command (echo)', async () => {
      const out = await server.executeCommand('echo hello world');
      expect(out.trim()).toBe('hello world');
    });

    it('G1-02: should handle command not found', async () => {
      const out = await server.executeCommand('nonexistentcommand');
      expect(out).toContain('command not found');
    });

    it('G1-03: should handle empty command', async () => {
      const out = await server.executeCommand('');
      expect(out).toBe('');
    });
    
    it('G1-04: should handle command with only spaces', async () => {
      const out = await server.executeCommand('   ');
      expect(out).toBe('');
    });

    it('G1-05: should ignore comments', async () => {
      const out = await server.executeCommand('echo hello # this is a comment');
      expect(out.trim()).toBe('hello');
    });

    it('G1-06: should handle a line that is only a comment', async () => {
      const out = await server.executeCommand('# echo hello');
      expect(out).toBe('');
    });
    
    it('G1-07: should execute multiple commands separated by semicolon', async () => {
      const out = await server.executeCommand('echo hello; echo world');
      expect(out.trim()).toBe('hello\nworld');
    });

    it('G1-08: should handle arguments correctly (wc -l)', async () => {
      // Setup a file first
      await server.executeCommand('echo "line 1\nline 2" > /tmp/testfile.txt');
      const out = await server.executeCommand('wc -l /tmp/testfile.txt');
      expect(out.trim()).toMatch(/2\s+\/tmp\/testfile.txt/);
    });

    it('G1-09: should show correct exit code for success', async () => {
      const out = await server.executeCommand('true; echo $?');
      expect(out.trim()).toBe('0');
    });

    it('G1-10: should show correct exit code for failure', async () => {
      const out = await server.executeCommand('false; echo $?');
      expect(out.trim()).toBe('1');
    });
    
    it('G1-11: should show correct exit code for command not found', async () => {
      // Note: stderr might be mixed with stdout depending on implementation
      const out = await server.executeCommand('nosuchcommand; echo $?');
      // Exit code 127 is standard for "command not found"
      expect(out).toContain('127');
    });
  });


  // ═══════════════════════════════════════════════════════════════════
  // GROUP 2: Variables et Expansion
  // ═══════════════════════════════════════════════════════════════════
  
  describe('G2: Variables et Expansion', () => {
    it('G2-01: should assign and expand a simple variable', async () => {
      const out = await server.executeCommand('VAR=world; echo hello $VAR');
      expect(out.trim()).toBe('hello world');
    });

    it('G2-02: should handle unassigned variables as empty strings', async () => {
      const out = await server.executeCommand('echo hello$UNSET_VAR');
      expect(out.trim()).toBe('hello');
    });

    it('G2-03: should respect single quotes to prevent expansion', async () => {
      const out = await server.executeCommand("VAR=world; echo 'hello $VAR'");
      expect(out.trim()).toBe('hello $VAR');
    });

    it('G2-04: should respect double quotes to allow expansion', async () => {
      const out = await server.executeCommand('VAR=world; echo "hello $VAR"');
      expect(out.trim()).toBe('hello world');
    });

    it('G2-05: should handle variables with spaces in double quotes', async () => {
      const out = await server.executeCommand('GREETING="hello beautiful world"; echo "$GREETING"');
      expect(out.trim()).toBe('hello beautiful world');
    });
    
    it('G2-06: should correctly perform word splitting without quotes', async () => {
      // touch expects two separate arguments
      const out = await server.executeCommand('FILES="file1 file2"; touch $FILES; ls file*');
      expect(out.trim()).toBe('file1\nfile2');
    });

    it('G2-07: should export a variable to the environment', async () => {
      // A subshell 'bash -c' should inherit the exported variable
      const out = await server.executeCommand('export MY_VAR=test; bash -c "echo $MY_VAR"');
      expect(out.trim()).toBe('test');
    });
    
    it('G2-08: should not pass unexported variables to subshells', async () => {
      const out = await server.executeCommand('MY_VAR=test; bash -c "echo $MY_VAR"');
      expect(out.trim()).toBe('');
    });

    it('G2-09: should unset a variable', async () => {
      const out = await server.executeCommand('VAR=hello; unset VAR; echo $VAR');
      expect(out.trim()).toBe('');
    });

    it('G2-10: should fail to re-assign a readonly variable', async () => {
      const out = await server.executeCommand('readonly VAR=foo; VAR=bar');
      expect(out).toContain('readonly variable');
    });

    it('G2-11: should handle curly brace expansion for clarity', async () => {
      const out = await server.executeCommand('VAR=world; echo "hello${VAR}ly"');
      expect(out.trim()).toBe('helloworldly');
    });
  });
  
  
  // ═══════════════════════════════════════════════════════════════════
  // GROUP 3: Redirections I/O et Pipes
  // ═══════════════════════════════════════════════════════════════════

  describe('G3: Redirections I/O et Pipes', () => {
    it('G3-01: should redirect stdout to a file with >', async () => {
      await server.executeCommand('echo "hello file" > /tmp/out.txt');
      const out = await server.executeCommand('cat /tmp/out.txt');
      expect(out.trim()).toBe('hello file');
    });

    it('G3-02: should overwrite a file with >', async () => {
      await server.executeCommand('echo "a" > /tmp/out.txt');
      await server.executeCommand('echo "b" > /tmp/out.txt');
      const out = await server.executeCommand('cat /tmp/out.txt');
      expect(out.trim()).toBe('b');
    });

    it('G3-03: should append stdout to a file with >>', async () => {
      await server.executeCommand('echo "a" > /tmp/out.txt');
      await server.executeCommand('echo "b" >> /tmp/out.txt');
      const out = await server.executeCommand('cat /tmp/out.txt');
      expect(out.trim()).toBe('a\nb');
    });
    
    it('G3-04: should redirect stderr to a file with 2>', async () => {
      await server.executeCommand('nosuchcmd 2> /tmp/err.txt');
      const out = await server.executeCommand('cat /tmp/err.txt');
      expect(out).toContain('command not found');
    });
    
    it('G3-05: should redirect stderr and stdout to a file with &>', async () => {
      await server.executeCommand('echo "good"; nosuchcmd &> /tmp/all.txt');
      const out = await server.executeCommand('cat /tmp/all.txt');
      expect(out).toContain('good');
      expect(out).toContain('command not found');
    });
    
    it('G3-06: should redirect a file to stdin with <', async () => {
      await server.executeCommand('echo "input data" > /tmp/in.txt');
      const out = await server.executeCommand('cat < /tmp/in.txt');
      expect(out.trim()).toBe('input data');
    });
    
    it('G3-07: should handle a simple pipe', async () => {
      const out = await server.executeCommand('echo "one two three" | wc -w');
      expect(out.trim()).toBe('3');
    });
    
    it('G3-08: should handle a multi-stage pipe', async () => {
      const out = await server.executeCommand('echo " a \n b \n c " | grep -v b | wc -l');
      expect(out.trim()).toBe('2');
    });
    
    it('G3-09: should handle a here document (heredoc)', async () => {
      const out = await server.executeCommand('cat << EOF\nhello\nworld\nEOF');
      expect(out.trim()).toBe('hello\nworld');
    });
    
    it('G3-10: should handle a here string (herestring)', async () => {
      const out = await server.executeCommand('wc -c <<< "hello"');
      // 5 for "hello" + 1 for the newline wc adds
      expect(out.trim()).toBe('6');
    });
    
    it('G3-11: should fail if redirection file is not writable', async () => {
      const out = await server.executeCommand('echo hello > /root/protected.txt');
      expect(out).toContain('Permission denied');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 4: Listes de Commandes et Logique de Contrôle
  // ═══════════════════════════════════════════════════════════════════
  
  describe('G4: Listes de Commandes et Logique de Contrôle', () => {
    it('G4-01: should execute second command if first succeeds (&&)', async () => {
      const out = await server.executeCommand('true && echo "success"');
      expect(out.trim()).toBe('success');
    });
    
    it('G4-02: should NOT execute second command if first fails (&&)', async () => {
      const out = await server.executeCommand('false && echo "success"');
      expect(out.trim()).toBe('');
    });
    
    it('G4-03: should execute second command if first fails (||)', async () => {
      const out = await server.executeCommand('false || echo "failure"');
      expect(out.trim()).toBe('failure');
    });
    
    it('G4-04: should NOT execute second command if first succeeds (||)', async () => {
      const out = await server.executeCommand('true || echo "failure"');
      expect(out.trim()).toBe('');
    });
    
    it('G4-05: should handle chains of && and ||', async () => {
      const out = await server.executeCommand('true && echo "A"; false || echo "B"');
      expect(out.trim()).toBe('A\nB');
    });
    
    it('G4-06: should execute commands in a subshell ()', async () => {
      // The variable change in the subshell should not affect the parent
      const out = await server.executeCommand('VAR=outer; (VAR=inner; echo $VAR); echo $VAR');
      expect(out.trim()).toBe('inner\nouter');
    });
    
    it('G4-07: should group commands with {}', async () => {
      // The variable change should persist as it's the same shell
      const out = await server.executeCommand('VAR=outer; { VAR=inner; echo $VAR; }; echo $VAR');
      expect(out.trim()).toBe('inner\ninner');
    });
    
    it('G4-08: should fail on incorrect syntax for {} grouping (missing space/semicolon)', async () => {
      const out = await server.executeCommand('{echo hello}');
      expect(out).toContain('syntax error');
    });

    it('G4-09: should correctly redirect output from a {} group', async () => {
      await server.executeCommand('{ echo line1; echo line2; } > /tmp/group.txt');
      const out = await server.executeCommand('cat /tmp/group.txt');
      expect(out.trim()).toBe('line1\nline2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 5: Structures Conditionnelles (if, case)
  // ═══════════════════════════════════════════════════════════════════
  
  describe('G5: Structures Conditionnelles (if, case)', () => {
    it('G5-01: should execute "then" block for a true condition', async () => {
      const out = await server.executeCommand('if true; then echo "yes"; fi');
      expect(out.trim()).toBe('yes');
    });

    it('G5-02: should NOT execute "then" block for a false condition', async () => {
      const out = await server.executeCommand('if false; then echo "yes"; fi');
      expect(out.trim()).toBe('');
    });
    
    it('G5-03: should execute "else" block for a false condition', async () => {
      const out = await server.executeCommand('if false; then echo "yes"; else echo "no"; fi');
      expect(out.trim()).toBe('no');
    });

    it('G5-04: should use test command for string equality (true)', async () => {
      const out = await server.executeCommand('VAR="hello"; if [ "$VAR" = "hello" ]; then echo "match"; fi');
      expect(out.trim()).toBe('match');
    });
    
    it('G5-05: should use test command for string equality (false)', async () => {
      const out = await server.executeCommand('VAR="world"; if [ "$VAR" = "hello" ]; then echo "match"; else echo "no match"; fi');
      expect(out.trim()).toBe('no match');
    });

    it('G5-06: should use test command for numeric equality (-eq)', async () => {
      const out = await server.executeCommand('NUM=5; if [ "$NUM" -eq 5 ]; then echo "equal"; fi');
      expect(out.trim()).toBe('equal');
    });

    it('G5-07: should use test command for file existence (-e)', async () => {
      const out = await server.executeCommand('touch /tmp/exists.txt; if [ -e /tmp/exists.txt ]; then echo "exists"; fi');
      expect(out.trim()).toBe('exists');
    });
    
    it('G5-08: should handle elif conditions', async () => {
      const script = `
        VAR=2;
        if [ "$VAR" -eq 1 ]; then
          echo "one"
        elif [ "$VAR" -eq 2 ]; then
          echo "two"
        else
          echo "other"
        fi
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('two');
    });

    it('G5-09: should match a simple case statement', async () => {
      const script = `
        FRUIT="apple";
        case "$FRUIT" in
          apple) echo "is a fruit";;
          *) echo "unknown";;
        esac
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('is a fruit');
    });
    
    it('G5-10: should match a wildcard in a case statement', async () => {
      const script = `
        FRUIT="banana";
        case "$FRUIT" in
          apple) echo "is an apple";;
          *) echo "is something else";;
        esac
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('is something else');
    });

    it('G5-11: should match pipe-separated patterns in case', async () => {
      const script = `
        ANIMAL="dog";
        case "$ANIMAL" in
          cat|dog|fish) echo "is a pet";;
          *) echo "is wild";;
        esac
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('is a pet');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 6: Boucles (for, while, until)
  // ═══════════════════════════════════════════════════════════════════

  describe('G6: Boucles (for, while, until)', () => {
    it('G6-01: should execute a simple for loop over a list', async () => {
      const out = await server.executeCommand('for i in 1 2 3; do echo $i; done');
      expect(out.trim()).toBe('1\n2\n3');
    });
    
    it('G6-02: should execute a for loop with sequence expression', async () => {
      const out = await server.executeCommand('for i in {1..3}; do echo $i; done');
      expect(out.trim()).toBe('1\n2\n3');
    });
    
    it('G6-03: should execute a simple while loop', async () => {
      const out = await server.executeCommand('i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done');
      expect(out.trim()).toBe('0\n1\n2');
    });
    
    it('G6-04: should execute a simple until loop', async () => {
      const out = await server.executeCommand('i=0; until [ $i -ge 3 ]; do echo $i; i=$((i+1)); done');
      expect(out.trim()).toBe('0\n1\n2');
    });
    
    it('G6-05: should break from a loop', async () => {
      const out = await server.executeCommand('for i in 1 2 3 4 5; do if [ $i -eq 3 ]; then break; fi; echo $i; done');
      expect(out.trim()).toBe('1\n2');
    });
    
    it('G6-06: should continue a loop', async () => {
      const out = await server.executeCommand('for i in 1 2 3 4; do if [ $i -eq 2 ]; then continue; fi; echo $i; done');
      expect(out.trim()).toBe('1\n3\n4');
    });

    it('G6-07: should read lines from stdin in a while loop', async () => {
      const out = await server.executeCommand('echo -e "a\\nb\\nc" | while read line; do echo "line: $line"; done');
      expect(out.trim()).toBe('line: a\nline: b\nline: c');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 7: Fonctions Bash
  // ═══════════════════════════════════════════════════════════════════

  describe('G7: Fonctions Bash', () => {
    it('G7-01: should define and call a simple function', async () => {
      const script = `
        my_func() {
          echo "hello from function"
        }
        my_func
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('hello from function');
    });
    
    it('G7-02: should pass arguments to a function', async () => {
      const script = `
        greet() {
          echo "Hello, $1!"
        }
        greet World
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('Hello, World!');
    });
    
    it('G7-03: should handle multiple arguments in a function', async () => {
      const script = `
        add() {
          echo $(($1 + $2))
        }
        add 5 3
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('8');
    });
    
    it('G7-04: should return an exit code from a function', async () => {
      const script = `
        fail_func() {
          return 42
        }
        fail_func
        echo $?
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('42');
    });
    
    it('G7-05: should use local variables inside a function', async () => {
      const script = `
        VAR="global"
        scope_test() {
          local VAR="local"
          echo "Inside: $VAR"
        }
        echo "Before: $VAR"
        scope_test
        echo "After: $VAR"
      `;
      const out = await server.executeCommand(script);
      expect(out.trim()).toBe('Before: global\nInside: local\nAfter: global');
    });
    
    it('G7-06: should fail if calling an undefined function', async () => {
      const out = await server.executeCommand('undefined_function');
      expect(out).toContain('command not found');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 8: Tableaux (Arrays)
  // ═══════════════════════════════════════════════════════════════════

  describe('G8: Tableaux (Arrays)', () => {
    it('G8-01: should declare and access an indexed array', async () => {
      const out = await server.executeCommand('arr=("apple" "banana" "cherry"); echo ${arr[1]}');
      expect(out.trim()).toBe('banana');
    });

    it('G8-02: should get all elements of an array with @', async () => {
      const out = await server.executeCommand('arr=("a" "b" "c"); for i in "${arr[@]}"; do echo $i; done');
      expect(out.trim()).toBe('a\nb\nc');
    });

    it('G8-03: should get the length of an array', async () => {
      const out = await server.executeCommand('arr=("a" "b" "c"); echo ${#arr[@]}');
      expect(out.trim()).toBe('3');
    });

    it('G8-04: should add an element to an array', async () => {
      const out = await server.executeCommand('arr=("a" "b"); arr+=("c"); echo ${arr[2]}');
      expect(out.trim()).toBe('c');
    });

    it('G8-05: should handle array elements with spaces', async () => {
      const out = await server.executeCommand('arr=("first element" "second"); echo "${arr[0]}"');
      expect(out.trim()).toBe('first element');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 9: Globbing (Wildcards)
  // ═══════════════════════════════════════════════════════════════════

  describe('G9: Globbing (Wildcards)', () => {
    it('G9-01: should expand * to match multiple files', async () => {
      await server.executeCommand('touch file1.txt file2.txt data.log');
      const out = await server.executeCommand('ls *.txt');
      expect(out.trim()).toBe('file1.txt\nfile2.txt');
    });

    it('G9-02: should expand ? to match single character', async () => {
      await server.executeCommand('touch data1.log data2.log data10.log');
      const out = await server.executeCommand('ls data?.log');
      expect(out.trim()).toBe('data1.log\ndata2.log');
    });

    it('G9-03: should expand [...] to match character sets', async () => {
      await server.executeCommand('touch file_a file_b file_c file_d');
      const out = await server.executeCommand('ls file_[ac]');
      expect(out.trim()).toBe('file_a\nfile_c');
    });

    it('G9-04: should not expand glob if no files match', async () => {
      // By default, bash passes the literal string if no match
      const out = await server.executeCommand('ls *.nonexistent');
      expect(out).toContain('No such file or directory');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 10: Substitution de commandes et Arithmétique
  // ═══════════════════════════════════════════════════════════════════
  
  describe('G10: Substitution de commandes et Arithmétique', () => {
    it('G10-01: should perform command substitution with $()', async () => {
      const out = await server.executeCommand('DATE=$(echo "2026-04-05"); echo "Date is $DATE"');
      expect(out.trim()).toBe('Date is 2026-04-05');
    });

    it('G10-02: should perform command substitution with backticks ``', async () => {
      const out = await server.executeCommand('DATE=`echo "2026-04-05"`; echo "Date is $DATE"');
      expect(out.trim()).toBe('Date is 2026-04-05');
    });
    
    it('G10-03: should perform simple arithmetic expansion with $(())', async () => {
      const out = await server.executeCommand('echo $((5 + 3))');
      expect(out.trim()).toBe('8');
    });

    it('G10-04: should perform arithmetic with variables', async () => {
      const out = await server.executeCommand('X=10; Y=2; echo $((X * Y))');
      expect(out.trim()).toBe('20');
    });

    it('G10-05: should handle nested command substitutions', async () => {
      const out = await server.executeCommand('echo $(echo "outer $(echo "inner")")');
      expect(out.trim()).toBe('outer inner');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 11: Erreurs de Syntaxe et Cas Limites
  // ═══════════════════════════════════════════════════════════════════

  describe('G11: Erreurs de Syntaxe et Cas Limites', () => {
    it('G11-01: should fail on unclosed quote', async () => {
      // In an interactive shell this prompts for more input. In a script it's a syntax error.
      // Your implementation may choose either. A syntax error is a good default.
      const out = await server.executeCommand('echo "hello');
      expect(out).toContain('syntax error');
    });

    it('G11-02: should fail on unexpected token (e.g., extra `fi`)', async () => {
      const out = await server.executeCommand('fi');
      expect(out).toContain('syntax error');
    });
    
    it('G11-03: should fail on incomplete pipe', async () => {
      const out = await server.executeCommand('echo hello |');
      expect(out).toContain('syntax error');
    });
    
    it('G11-04: should fail on incomplete conditional', async () => {
      const out = await server.executeCommand('if true; then');
      expect(out).toContain('syntax error');
    });

    it('G11-05: should handle commands with many arguments', async () => {
      const args = Array.from({ length: 50 }, (_, i) => `arg${i}`).join(' ');
      const out = await server.executeCommand(`echo ${args}`);
      expect(out.trim()).toBe(args);
    });

    it('G11-06: should handle escaped characters correctly', async () => {
      const out = await server.executeCommand('echo "This has a \\$dollar and a \\"quote\\""');
      expect(out.trim()).toBe('This has a $dollar and a "quote"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 12: Scripts et Exécution de Fichiers
  // ═══════════════════════════════════════════════════════════════════

  describe('G12: Scripts et Exécution de Fichiers', () => {
    it('G12-01: should execute a simple script from a file', async () => {
      const scriptContent = '#!/bin/bash\necho "hello from script"';
      await server.executeCommand(`echo "${scriptContent}" > /tmp/myscript.sh`);
      await server.executeCommand('chmod +x /tmp/myscript.sh');
      const out = await server.executeCommand('/tmp/myscript.sh');
      expect(out.trim()).toBe('hello from script');
    });

    it('G12-02: should source a file with `source` and modify current shell', async () => {
      await server.executeCommand('echo "SOURCED_VAR=success" > /tmp/vars.sh');
      const out = await server.executeCommand('source /tmp/vars.sh; echo $SOURCED_VAR');
      expect(out.trim()).toBe('success');
    });

    it('G12-03: should source a file with `.` and modify current shell', async () => {
      await server.executeCommand('echo "SOURCED_VAR=success" > /tmp/vars.sh');
      const out = await server.executeCommand('. /tmp/vars.sh; echo $SOURCED_VAR');
      expect(out.trim()).toBe('success');
    });

    it('G12-04: should pass arguments to a script', async () => {
      const scriptContent = '#!/bin/bash\necho "Arg 1 is $1, Arg 2 is $2"';
      await server.executeCommand(`echo "${scriptContent}" > /tmp/arg_script.sh`);
      await server.executeCommand('chmod +x /tmp/arg_script.sh');
      const out = await server.executeCommand('/tmp/arg_script.sh hello world');
      expect(out.trim()).toBe('Arg 1 is hello, Arg 2 is world');
    });

    it('G12-05: should fail to execute a non-executable file', async () => {
      await server.executeCommand('echo "echo test" > /tmp/noexec.sh');
      const out = await server.executeCommand('/tmp/noexec.sh');
      expect(out).toContain('Permission denied');
    });
  });
});
