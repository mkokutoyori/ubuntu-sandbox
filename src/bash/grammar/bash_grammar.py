"""
Bash Grammar Specification — PLY (Python Lex-Yacc) Reference

This file defines the formal grammar for the bash subset supported by the
simulator's bash interpreter. It serves as the authoritative reference for
the TypeScript implementation (BashLexer + BashParser).

Usage:
    python3 bash_grammar.py          # Validates grammar, generates parser.out + parsetab.py
    echo 'echo hello' | python3 bash_grammar.py   # Parse from stdin

NOT used at runtime — the TypeScript implementation is the real interpreter.
"""

import ply.lex as lex
import ply.yacc as yacc
import sys

# ═══════════════════════════════════════════════════════════════════════
# LEXER — Token Definitions
# ═══════════════════════════════════════════════════════════════════════

reserved = {
    'if':       'IF',
    'then':     'THEN',
    'elif':     'ELIF',
    'else':     'ELSE',
    'fi':       'FI',
    'for':      'FOR',
    'in':       'IN',
    'do':       'DO',
    'done':     'DONE',
    'while':    'WHILE',
    'until':    'UNTIL',
    'case':     'CASE',
    'esac':     'ESAC',
    'function': 'FUNCTION',
    'time':     'TIME',
}

tokens = [
    # Literals and identifiers
    'WORD',
    'ASSIGNMENT_WORD',
    'NUMBER',

    # Strings
    'SINGLE_QUOTED',
    'DOUBLE_QUOTED',

    # Variable references
    'VAR_SIMPLE',
    'VAR_BRACED',
    'VAR_SPECIAL',

    # Command & arithmetic substitution
    'CMD_SUB',
    'CMD_SUB_BACKTICK',
    'ARITH_SUB',

    # Operators
    'PIPE',
    'AND_IF',
    'OR_IF',
    'SEMI',
    'DSEMI',
    'AMP',
    'NEWLINE',

    # Redirections
    'LESS',
    'GREAT',
    'DGREAT',
    'LESSAND',
    'GREATAND',
    'FD_GREAT',
    'FD_DGREAT',
    'HEREDOC',
    'HERESTRING',

    # Grouping
    'LPAREN',
    'RPAREN',
    'LBRACE',
    'RBRACE',
    'LBRACKET',
    'RBRACKET',
    'DLBRACKET',
    'DRBRACKET',
] + list(reserved.values())


# ─── Simple token rules ─────────────────────────────────────────────

t_AND_IF    = r'&&'
t_OR_IF     = r'\|\|'
t_DSEMI     = r';;'
t_DLBRACKET = r'\[\['
t_DRBRACKET = r'\]\]'
t_HERESTRING = r'<<<'
t_HEREDOC   = r'<<(?!<)'
t_DGREAT    = r'>>(?!>)'
t_GREATAND  = r'>&'
t_LESSAND   = r'<&'
t_LPAREN    = r'\('
t_RPAREN    = r'\)'


def t_PIPE(t):
    r'\|(?!\|)'
    return t

def t_SEMI(t):
    r';(?!;)'
    return t

def t_AMP(t):
    r'&(?!&|>)'
    return t

def t_LBRACKET(t):
    r'\[(?!\[)'
    return t

def t_RBRACKET(t):
    r'\](?!\])'
    return t

def t_GREAT(t):
    r'>(?!>|&)'
    return t

def t_LESS(t):
    r'<(?!<|&)'
    return t


def t_FD_DGREAT(t):
    r'[0-9]+>>'
    return t


def t_FD_GREAT(t):
    r'[0-9]+>(?!>)'
    return t


def t_ARITH_SUB(t):
    r'\$\(\(.*?\)\)'
    return t


def t_CMD_SUB(t):
    r'\$\([^)]*\)'
    return t


def t_CMD_SUB_BACKTICK(t):
    r'`[^`]*`'
    return t


def t_VAR_BRACED(t):
    r'\$\{[^}]+\}'
    return t


def t_VAR_SPECIAL(t):
    r'\$[\?\$\!#@\*0-9]'
    return t


def t_VAR_SIMPLE(t):
    r'\$[A-Za-z_][A-Za-z_0-9]*'
    return t


def t_SINGLE_QUOTED(t):
    r"'[^']*'"
    return t


def t_DOUBLE_QUOTED(t):
    r'"([^"\\]|\\.)*"'
    return t


def t_ASSIGNMENT_WORD(t):
    r'[A-Za-z_][A-Za-z_0-9]*=[^\s;|&<>()]*'
    return t


def t_WORD(t):
    r'[A-Za-z_0-9/\.\-\~\+\:@\^\\*?]+'
    t.type = reserved.get(t.value, 'WORD')
    return t


def t_NUMBER(t):
    r'[0-9]+'
    t.value = int(t.value)
    return t


def t_NEWLINE(t):
    r'\n+'
    t.lexer.lineno += len(t.value)
    return t


def t_COMMENT(t):
    r'\#[^\n]*'
    pass  # discard


t_ignore = ' \t'


def t_error(t):
    print(f"Lexer error: unexpected character '{t.value[0]}' at line {t.lineno}")
    t.lexer.skip(1)


lexer = lex.lex()


# ═══════════════════════════════════════════════════════════════════════
# PARSER — Grammar Rules
# ═══════════════════════════════════════════════════════════════════════

# --- Program ---

def p_program(p):
    """program : linebreak complete_commands linebreak
               | linebreak"""
    if len(p) == 4:
        p[0] = ('program', p[2])
    else:
        p[0] = ('program', [])


def p_complete_commands(p):
    """complete_commands : complete_commands newline_list complete_command
                        | complete_command"""
    if len(p) == 4:
        p[0] = p[1] + [p[3]]
    else:
        p[0] = [p[1]]


def p_complete_command(p):
    """complete_command : and_or_list separator_op
                       | and_or_list"""
    p[0] = p[1]


# --- And/Or List ---

def p_and_or_list(p):
    """and_or_list : and_or_list AND_IF linebreak pipeline
                   | and_or_list OR_IF linebreak pipeline
                   | pipeline"""
    if len(p) == 5:
        p[0] = ('and_or', p[2], p[1], p[4])
    else:
        p[0] = p[1]


# --- Pipeline ---

def p_pipeline(p):
    """pipeline : pipeline PIPE linebreak command
                | command"""
    if len(p) == 5:
        p[0] = ('pipeline', p[1], p[4])
    else:
        p[0] = p[1]


# --- Command ---

def p_command(p):
    """command : simple_command
              | compound_command
              | compound_command redirect_list
              | function_def"""
    if len(p) == 3:
        p[0] = ('redirected', p[1], p[2])
    else:
        p[0] = p[1]


# --- Simple Command ---

def p_simple_command_prefix_word_suffix(p):
    """simple_command : cmd_prefix cmd_word cmd_suffix"""
    p[0] = ('simple_command', p[1], p[2], p[3])

def p_simple_command_prefix_word(p):
    """simple_command : cmd_prefix cmd_word"""
    p[0] = ('simple_command', p[1], p[2], [])

def p_simple_command_prefix(p):
    """simple_command : cmd_prefix"""
    p[0] = ('simple_command', p[1], None, [])

def p_simple_command_word_suffix(p):
    """simple_command : cmd_word cmd_suffix"""
    p[0] = ('simple_command', [], p[1], p[2])

def p_simple_command_word(p):
    """simple_command : cmd_word"""
    p[0] = ('simple_command', [], p[1], [])


def p_cmd_prefix(p):
    """cmd_prefix : cmd_prefix ASSIGNMENT_WORD
                  | cmd_prefix io_redirect
                  | ASSIGNMENT_WORD
                  | io_redirect"""
    if len(p) == 3:
        p[0] = p[1] + [p[2]]
    else:
        p[0] = [p[1]]


def p_cmd_word(p):
    """cmd_word : word"""
    p[0] = p[1]


def p_cmd_suffix(p):
    """cmd_suffix : cmd_suffix word
                  | cmd_suffix io_redirect
                  | word
                  | io_redirect"""
    if len(p) == 3:
        p[0] = p[1] + [p[2]]
    else:
        p[0] = [p[1]]


# --- Compound Commands ---

def p_compound_command(p):
    """compound_command : brace_group
                        | subshell
                        | if_clause
                        | for_clause
                        | while_clause
                        | until_clause
                        | case_clause"""
    p[0] = p[1]


def p_brace_group(p):
    """brace_group : LBRACE compound_list RBRACE"""
    p[0] = ('brace_group', p[2])


def p_subshell(p):
    """subshell : LPAREN compound_list RPAREN"""
    p[0] = ('subshell', p[2])


def p_do_group(p):
    """do_group : DO compound_list DONE"""
    p[0] = p[2]


# --- If ---

def p_if_clause_else(p):
    """if_clause : IF compound_list THEN compound_list ELSE compound_list FI"""
    p[0] = ('if', p[2], p[4], [], p[6])

def p_if_clause_elif(p):
    """if_clause : IF compound_list THEN compound_list elif_parts FI"""
    p[0] = ('if', p[2], p[4], p[5], None)

def p_if_clause_elif_else(p):
    """if_clause : IF compound_list THEN compound_list elif_parts ELSE compound_list FI"""
    p[0] = ('if', p[2], p[4], p[5], p[7])

def p_if_clause_simple(p):
    """if_clause : IF compound_list THEN compound_list FI"""
    p[0] = ('if', p[2], p[4], [], None)


def p_elif_parts_many(p):
    """elif_parts : elif_parts ELIF compound_list THEN compound_list"""
    p[0] = p[1] + [('elif', p[3], p[5])]

def p_elif_parts_one(p):
    """elif_parts : ELIF compound_list THEN compound_list"""
    p[0] = [('elif', p[2], p[4])]


# --- For ---

def p_for_clause_in(p):
    """for_clause : FOR WORD linebreak IN wordlist separator do_group"""
    p[0] = ('for', p[2], p[5], p[7])

def p_for_clause_bare(p):
    """for_clause : FOR WORD separator do_group"""
    p[0] = ('for', p[2], None, p[4])


# --- While / Until ---

def p_while_clause(p):
    """while_clause : WHILE compound_list do_group"""
    p[0] = ('while', p[2], p[3])


def p_until_clause(p):
    """until_clause : UNTIL compound_list do_group"""
    p[0] = ('until', p[2], p[3])


# --- Case ---

def p_case_clause_items(p):
    """case_clause : CASE word linebreak IN linebreak case_list ESAC"""
    p[0] = ('case', p[2], p[6])

def p_case_clause_empty(p):
    """case_clause : CASE word linebreak IN linebreak ESAC"""
    p[0] = ('case', p[2], [])


def p_case_list_many(p):
    """case_list : case_list case_item"""
    p[0] = p[1] + [p[2]]

def p_case_list_one(p):
    """case_list : case_item"""
    p[0] = [p[1]]


def p_case_item_body(p):
    """case_item : pattern RPAREN linebreak compound_list DSEMI linebreak"""
    p[0] = ('case_item', p[1], p[4])

def p_case_item_empty(p):
    """case_item : pattern RPAREN linebreak DSEMI linebreak"""
    p[0] = ('case_item', p[1], None)

def p_case_item_last(p):
    """case_item : pattern RPAREN linebreak compound_list linebreak"""
    p[0] = ('case_item', p[1], p[4])


def p_pattern_or(p):
    """pattern : pattern PIPE word"""
    p[0] = ('pattern_or', p[1], p[3])

def p_pattern_single(p):
    """pattern : word"""
    p[0] = p[1]


# --- Function Definition ---

def p_function_def_parens(p):
    """function_def : WORD LPAREN RPAREN linebreak function_body"""
    p[0] = ('function_def', p[1], p[5])

def p_function_def_keyword(p):
    """function_def : FUNCTION WORD linebreak function_body"""
    p[0] = ('function_def', p[2], p[4])

def p_function_def_keyword_parens(p):
    """function_def : FUNCTION WORD LPAREN RPAREN linebreak function_body"""
    p[0] = ('function_def', p[2], p[6])


def p_function_body(p):
    """function_body : compound_command"""
    p[0] = p[1]


# --- Compound List ---

def p_compound_list_term_sep(p):
    """compound_list : linebreak term separator"""
    p[0] = p[2]

def p_compound_list_term(p):
    """compound_list : linebreak term"""
    p[0] = p[2]


def p_term_chain(p):
    """term : term separator and_or_list"""
    p[0] = ('term', p[1], p[2], p[3])

def p_term_single(p):
    """term : and_or_list"""
    p[0] = p[1]


# --- Redirections ---

def p_io_redirect(p):
    """io_redirect : LESS word
                   | GREAT word
                   | DGREAT word
                   | LESSAND word
                   | GREATAND word
                   | FD_GREAT word
                   | FD_DGREAT word
                   | HEREDOC word
                   | HERESTRING word"""
    p[0] = ('redirect', p[1], p[2])


def p_redirect_list_many(p):
    """redirect_list : redirect_list io_redirect"""
    p[0] = p[1] + [p[2]]

def p_redirect_list_one(p):
    """redirect_list : io_redirect"""
    p[0] = [p[1]]


# --- Word ---

def p_word(p):
    """word : WORD
            | SINGLE_QUOTED
            | DOUBLE_QUOTED
            | VAR_SIMPLE
            | VAR_BRACED
            | VAR_SPECIAL
            | CMD_SUB
            | CMD_SUB_BACKTICK
            | ARITH_SUB
            | NUMBER
            | ASSIGNMENT_WORD
            | LBRACKET
            | RBRACKET
            | DLBRACKET
            | DRBRACKET"""
    p[0] = ('word', p[1])


def p_wordlist_many(p):
    """wordlist : wordlist word"""
    p[0] = p[1] + [p[2]]

def p_wordlist_one(p):
    """wordlist : word"""
    p[0] = [p[1]]


# --- Separators ---

def p_separator_op(p):
    """separator_op : AMP
                    | SEMI"""
    p[0] = p[1]


def p_separator_sep(p):
    """separator : separator_op linebreak"""
    p[0] = p[1]

def p_separator_newline(p):
    """separator : newline_list"""
    p[0] = ';'


def p_newline_list_many(p):
    """newline_list : newline_list NEWLINE"""
    pass

def p_newline_list_one(p):
    """newline_list : NEWLINE"""
    pass


def p_linebreak_nl(p):
    """linebreak : newline_list"""
    pass

def p_linebreak_empty(p):
    """linebreak : empty"""
    pass


def p_empty(p):
    """empty :"""
    pass


# --- Error ---

def p_error(p):
    if p:
        print(f"Syntax error at token {p.type} ('{p.value}') line {p.lineno}")
    else:
        print("Syntax error at end of input")


# Build the parser — generates parsetab.py and parser.out
parser = yacc.yacc(outputdir='/home/user/ubuntu-sandbox/src/bash/grammar')


# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("=== Bash Grammar — Token Types ===")
    print(f"Reserved keywords: {sorted(reserved.keys())}")
    other_tokens = sorted(set(tokens) - set(reserved.values()))
    print(f"Other tokens: {other_tokens}")
    print(f"Total: {len(tokens)} token types ({len(reserved)} reserved)")
    print()

    # Parse stdin if available
    if not sys.stdin.isatty():
        data = sys.stdin.read()
        print(f"=== Parsing {len(data)} chars ===")
        result = parser.parse(data, lexer=lexer)
        print(f"AST: {result}")
    else:
        # Smoke tests
        test_scripts = [
            'echo hello world',
            'ls -la | grep test > output.txt',
            'if [ -f /tmp/test ]; then echo found; fi',
            'for i in 1 2 3; do echo $i; done',
            'NAME="World"; echo "Hello $NAME"',
            'count=$((1 + 2))',
            'greet() { echo "Hello $1"; }',
            'case $opt in\na) echo A;;\nb) echo B;;\nesac',
            'cat file.txt | grep error | wc -l > /tmp/count',
            'while [ $x -lt 10 ]; do x=$((x+1)); done',
        ]
        print("=== Smoke Tests (lexer only) ===")
        for script in test_scripts:
            print(f"  Input:  {repr(script)}")
            lexer.input(script)
            toks = []
            while True:
                tok = lexer.token()
                if not tok:
                    break
                toks.append(tok)
            print(f"  Tokens: {[t.type for t in toks]}")
            print()

        print("=== Parse Tests ===")
        parse_tests = [
            'echo hello',
            'echo hello | cat',
            'echo hello && echo world',
            'NAME=World',
            'if true; then echo yes; fi',
            'for x in a b c; do echo $x; done',
            'while true; do echo loop; done',
            'greet() { echo hi; }',
            'case $x in\na) echo A;;\nesac',
        ]
        for script in parse_tests:
            print(f"  Input:  {repr(script)}")
            try:
                result = parser.parse(script, lexer=lexer)
                print(f"  AST:    {result}")
            except Exception as e:
                print(f"  ERROR:  {e}")
            print()
