import { describe, expect, it } from "vitest";
import { Lexer } from "@/command-kernel/ast/lexer";
import { Parser } from "@/command-kernel/ast/parser";
import { TokenType } from "@/command-kernel/ast/tokens";
import { UsageError } from "@/command-kernel/errors";

describe("Lexer", () => {
  it("tokenizes a simple command", () => {
    const tokens = new Lexer().tokenize("cat -n /etc/hosts");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.WORD,
      TokenType.WORD,
      TokenType.WORD,
      TokenType.EOF,
    ]);
    expect(tokens.map((t) => t.value)).toEqual(["cat", "-n", "/etc/hosts", ""]);
  });

  it("merges adjacent quoted and unquoted segments into one word", () => {
    const tokens = new Lexer().tokenize(`echo foo"bar baz"qux`);
    expect(tokens[1].value).toBe("foobar bazqux");
  });

  it("handles single quotes literally (no escape processing)", () => {
    const tokens = new Lexer().tokenize(`echo 'a\\nb'`);
    expect(tokens[1].value).toBe("a\\nb");
  });

  it("recognizes operators", () => {
    const tokens = new Lexer().tokenize("a | b && c || d ; e > f >> g < h");
    const types = tokens.map((t) => t.type);
    expect(types).toContain(TokenType.PIPE);
    expect(types).toContain(TokenType.AND);
    expect(types).toContain(TokenType.OR);
    expect(types).toContain(TokenType.SEMI);
    expect(types).toContain(TokenType.REDIR_OUT);
    expect(types).toContain(TokenType.REDIR_APPEND);
    expect(types).toContain(TokenType.REDIR_IN);
  });

  it("recognizes keywords", () => {
    const tokens = new Lexer().tokenize("if true then echo ok fi");
    expect(tokens[0].type).toBe(TokenType.IF);
    expect(tokens[2].type).toBe(TokenType.THEN);
    expect(tokens.at(-2)?.type).toBe(TokenType.FI);
  });

  it("rejects background jobs ('&' alone)", () => {
    expect(() => new Lexer().tokenize("sleep 1 &")).toThrow(UsageError);
  });

  it("supports comments", () => {
    const tokens = new Lexer().tokenize("echo hi # ceci est un commentaire\necho bye");
    expect(tokens.map((t) => t.value)).toEqual(["echo", "hi", "\n", "echo", "bye", ""]);
  });
});

describe("Parser", () => {
  const parse = (src: string) => new Parser().parse(new Lexer().tokenize(src));

  it("parses a simple command", () => {
    const ast = parse("cat -n /etc/hosts");
    expect(ast).toEqual({
      kind: "command",
      name: "cat",
      argv: [
        { text: "-n", noExpand: false },
        { text: "/etc/hosts", noExpand: false },
      ],
      redirections: [],
    });
  });

  it("parses a pipeline", () => {
    const ast = parse("ls | grep foo | wc -l");
    expect(ast.kind).toBe("pipeline");
    if (ast.kind === "pipeline") {
      expect(ast.stages).toHaveLength(3);
      expect(ast.stages[1]).toMatchObject({ name: "grep", argv: [{ text: "foo", noExpand: false }] });
    }
  });

  it("parses && and || with correct associativity", () => {
    const ast = parse("a && b || c");
    expect(ast.kind).toBe("or");
    if (ast.kind === "or") {
      expect(ast.left.kind).toBe("and");
    }
  });

  it("parses a sequence separated by ;", () => {
    const ast = parse("echo a ; echo b ; echo c");
    expect(ast.kind).toBe("sequence");
    if (ast.kind === "sequence") expect(ast.statements).toHaveLength(3);
  });

  it("parses redirections on a simple command", () => {
    const ast = parse("cat < in.txt > out.txt");
    expect(ast).toMatchObject({
      kind: "command",
      name: "cat",
      redirections: [
        { kind: "redirect", mode: "in", target: "in.txt" },
        { kind: "redirect", mode: "out", target: "out.txt" },
      ],
    });
  });

  it("parses an if/then/else/fi block", () => {
    const ast = parse("if grep -q foo file; then echo yes; else echo no; fi");
    expect(ast.kind).toBe("if");
    if (ast.kind === "if") {
      expect(ast.condition).toMatchObject({ name: "grep" });
      expect(ast.thenBranch).toMatchObject({ name: "echo", argv: [{ text: "yes", noExpand: false }] });
      expect(ast.elseBranch).toMatchObject({ name: "echo", argv: [{ text: "no", noExpand: false }] });
    }
  });

  it("parses a for loop", () => {
    const ast = parse("for x in a b c; do echo $x; done");
    expect(ast.kind).toBe("for");
    if (ast.kind === "for") {
      expect(ast.variable).toBe("x");
      expect(ast.items).toEqual(["a", "b", "c"]);
    }
  });

  it("parses a while loop", () => {
    const ast = parse("while true; do echo tick; done");
    expect(ast.kind).toBe("while");
  });

  it("parses a subshell", () => {
    const ast = parse("(cd /tmp; echo hi)");
    expect(ast.kind).toBe("subshell");
  });

  it("parses a standalone assignment", () => {
    const ast = parse("x=42");
    expect(ast).toEqual({ kind: "assign", name: "x", value: "42" });
  });

  it("rejects a pipeline made of compound statements", () => {
    expect(() => parse("if true; then echo a; fi | grep a")).toThrow(UsageError);
  });

  it("reports a syntax error when a block is left unclosed", () => {
    expect(() => parse("if true; then echo x")).toThrow(UsageError);
  });
});
