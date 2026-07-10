import { beforeEach, describe, expect, it } from "vitest";
import { CatCommand } from "@/command-kernel/commands/cat-command";
import { Interpreter } from "@/command-kernel/interpreter";
import { CommandRegistry } from "@/command-kernel/registry/command-registry";
import { ExitCommand } from "@/command-kernel/shell/exit";
import { History } from "@/command-kernel/shell/history";
import { PromptBuilder } from "@/command-kernel/shell/prompt-builder";
import { Shell } from "@/command-kernel/shell/shell";
import { createSession, SimpleUser } from "@/command-kernel/session/types";
import { InMemoryMachine } from "@/command-kernel/testing/in-memory-machine";
import { VirtualTerminal } from "@/command-kernel/terminal/virtual-terminal";
import { EchoCommand, FailCommand } from "./_test-commands";

describe("Shell (REPL) + VirtualTerminal", () => {
  let machine: InMemoryMachine;
  let registry: CommandRegistry;
  let interpreter: Interpreter;
  const user = new SimpleUser(1000, 1000, "alice", new Set(["users"]));

  beforeEach(() => {
    machine = new InMemoryMachine("sandbox");
    registry = new CommandRegistry();
    registry.register(() => new EchoCommand());
    registry.register(() => new CatCommand());
    registry.register(() => new FailCommand());
    registry.register(() => new ExitCommand());
    interpreter = new Interpreter(registry, machine);
  });

  function makeShell(): { shell: Shell; terminal: VirtualTerminal } {
    const terminal = new VirtualTerminal();
    const session = createSession({ id: "s1", user });
    const shell = new Shell(terminal, interpreter, machine, session);
    return { shell, terminal };
  }

  it("prints a welcome banner mentioning the hostname", async () => {
    const { shell, terminal } = makeShell();
    terminal.feed(); // EOF immédiat
    await shell.start();
    expect(terminal.output[0]).toContain("sandbox");
  });

  it("executes fed lines and records them in history", async () => {
    const { shell, terminal } = makeShell();
    terminal.feed("echo hi", "echo bye");
    await shell.start();
    expect(terminal.output.join("")).toContain("hi\n");
    expect(terminal.output.join("")).toContain("bye\n");
    expect(shell.history.all()).toEqual(["echo hi", "echo bye"]);
  });

  it("skips blank lines without touching history", async () => {
    const { shell, terminal } = makeShell();
    terminal.feed("", "   ", "echo once");
    await shell.start();
    expect(shell.history.all()).toEqual(["echo once"]);
  });

  it("stops the loop and sets the exit code on 'exit <code>'", async () => {
    const { shell, terminal } = makeShell();
    terminal.feed("exit 7", "echo should-not-run");
    const code = await shell.start();
    expect(code).toBe(7);
    expect(terminal.output.join("")).not.toContain("should-not-run");
  });

  it("stops on EOF (Ctrl+D) preserving the last exit code", async () => {
    const { shell, terminal } = makeShell();
    terminal.feed("echo ok");
    const code = await shell.start();
    expect(code).toBe(0);
  });

  it("reports a ShellError on the error stream and keeps the session alive", async () => {
    const { shell, terminal } = makeShell();
    terminal.feed("fail", "echo still-alive");
    await shell.start();
    expect(terminal.errors.join("")).toContain("échec volontaire");
    expect(terminal.output.join("")).toContain("still-alive\n");
  });

  it("reports command-not-found as a shell-level error (exit code 127)", async () => {
    const { shell, terminal } = makeShell();
    terminal.feed("doesnotexist");
    const code = await shell.start();
    expect(code).toBe(127);
    expect(terminal.errors.join("")).toContain("commande introuvable");
  });

  it("Ctrl+C triggers onInterrupt without crashing the shell", async () => {
    const { shell, terminal } = makeShell();
    expect(() => terminal.sendInterrupt()).not.toThrow();
    terminal.feed("echo still-fine");
    await shell.start();
    expect(terminal.output.join("")).toContain("still-fine\n");
  });

  it("runs a script file via runScriptFile()", async () => {
    await machine.fs.writeFile("/scripts/hello.sh", "echo from-script");
    const { shell } = makeShell();
    const code = await shell.runScriptFile("/scripts/hello.sh");
    expect(code).toBe(0);
  });
});

describe("History", () => {
  it("deduplicates consecutive identical entries", () => {
    const history = new History();
    history.push("ls");
    history.push("ls");
    history.push("pwd");
    expect(history.all()).toEqual(["ls", "pwd"]);
  });

  it("navigates previous/next like shell arrow keys", () => {
    const history = new History();
    history.push("a");
    history.push("b");
    history.push("c");
    expect(history.previous()).toBe("c");
    expect(history.previous()).toBe("b");
    expect(history.next()).toBe("c");
  });

  it("evicts the oldest entry once capacity is exceeded", () => {
    const history = new History(2);
    history.push("a");
    history.push("b");
    history.push("c");
    expect(history.all()).toEqual(["b", "c"]);
  });
});

describe("PromptBuilder", () => {
  it("substitutes \\u \\h \\w and \\$ (root vs non-root)", () => {
    const builder = new PromptBuilder();
    const user = new SimpleUser(1000, 1000, "alice");
    const session = createSession({ id: "s1", user, cwd: "/home/alice" });
    expect(builder.build(session, "sandbox")).toBe("alice@sandbox:/home/alice$ ");

    const root = new SimpleUser(0, 0, "root");
    const rootSession = createSession({ id: "s2", user: root, cwd: "/" });
    expect(builder.build(rootSession, "sandbox")).toBe("root@sandbox:/# ");
  });
});
