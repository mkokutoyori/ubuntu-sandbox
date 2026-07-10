import { beforeEach, describe, expect, it } from "vitest";
import { CatCommand } from "@/command-kernel/commands/cat-command";
import { ShutdownCommand } from "@/command-kernel/commands/shutdown-command";
import { CommandNotFoundError, PermissionError, UsageError } from "@/command-kernel/errors";
import { Interpreter } from "@/command-kernel/interpreter";
import { PipeBuffer } from "@/command-kernel/io/pipe-buffer";
import { CommandIO } from "@/command-kernel/io/types";
import { CommandRegistry } from "@/command-kernel/registry/command-registry";
import { Capability, createSession, SimpleUser } from "@/command-kernel/session/types";
import { FileSystemActor } from "@/command-kernel/machine/types";
import { InMemoryMachine } from "@/command-kernel/testing/in-memory-machine";
import {
  CounterCommand,
  EchoCommand,
  FailCommand,
  FalseCommand,
  TrueCommand,
  UpperCommand,
} from "./_test-commands";

const ROOT_ACTOR: FileSystemActor = { uid: 0, gid: 0 };

function makeIO(): CommandIO & { out: PipeBuffer; err: PipeBuffer } {
  const out = new PipeBuffer();
  const err = new PipeBuffer();
  return { stdin: new PipeBuffer(), stdout: out, stderr: err, out, err };
}

describe("Interpreter + Executor", () => {
  let machine: InMemoryMachine;
  let registry: CommandRegistry;
  let interpreter: Interpreter;
  const user = new SimpleUser(1000, 1000, "alice", new Set(["users"]), new Set([Capability.FS_READ]));
  const root = new SimpleUser(0, 0, "root");

  beforeEach(() => {
    machine = new InMemoryMachine("sandbox");
    registry = new CommandRegistry();
    registry.register(() => new EchoCommand());
    registry.register(() => new UpperCommand());
    registry.register(() => new TrueCommand());
    registry.register(() => new FalseCommand());
    registry.register(() => new FailCommand());
    registry.register(() => new CatCommand());
    registry.register(() => new ShutdownCommand());
    interpreter = new Interpreter(registry, machine);
  });

  it("runs a simple command and returns EXIT_OK", async () => {
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    const code = await interpreter.interpretLine("echo hello world", session, io);
    expect(code).toBe(0);
    expect(await io.out.readAll()).toBe("hello world\n");
  });

  it("pipes stdout of one command into stdin of the next", async () => {
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    const code = await interpreter.interpretLine("echo hello world | upper", session, io);
    expect(code).toBe(0);
    expect(await io.out.readAll()).toBe("HELLO WORLD\n");
  });

  it("evaluates && short-circuiting on failure", async () => {
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    const code = await interpreter.interpretLine("false && echo unreachable", session, io);
    expect(code).toBe(1);
    expect(await io.out.readAll()).toBe("");
  });

  it("evaluates || running the right side only on failure", async () => {
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    const code = await interpreter.interpretLine("false || echo fallback", session, io);
    expect(code).toBe(0);
    expect(await io.out.readAll()).toBe("fallback\n");
  });

  it("runs a sequence of statements separated by ;", async () => {
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    await interpreter.interpretLine("echo a; echo b; echo c", session, io);
    expect(await io.out.readAll()).toBe("a\nb\nc\n");
  });

  it("evaluates if/then/else based on exit code", async () => {
    const session = createSession({ id: "s1", user });
    const io1 = makeIO();
    await interpreter.interpretLine("if true; then echo yes; else echo no; fi", session, io1);
    expect(await io1.out.readAll()).toBe("yes\n");

    const io2 = makeIO();
    await interpreter.interpretLine("if false; then echo yes; else echo no; fi", session, io2);
    expect(await io2.out.readAll()).toBe("no\n");
  });

  it("iterates a for loop over its items, expanding the loop variable", async () => {
    const counter = { value: 0, seen: [] as string[] };
    registry.register(() => new CounterCommand(counter));
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    await interpreter.interpretLine("for x in a b c; do count; done", session, io);
    expect(counter.value).toBe(3);
    expect(counter.seen).toEqual(["a", "b", "c"]);
  });

  it("runs a while loop until the condition fails", async () => {
    const counter = { value: 0, seen: [] as string[] };
    registry.register(() => new CounterCommand(counter));
    // "false" fails immediately, so the loop body must never execute.
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    await interpreter.interpretLine("while false; do count; done", session, io);
    expect(counter.value).toBe(0);
  });

  it("expands variables assigned via 'x=value' and $? ", async () => {
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    await interpreter.interpretLine("x=hello; echo $x", session, io);
    expect(await io.out.readAll()).toBe("hello\n");

    const io2 = makeIO();
    await interpreter.interpretLine("false; echo $?", session, io2);
    expect(await io2.out.readAll()).toBe("1\n");
  });

  it("isolates subshell variable assignments from the parent session", async () => {
    const session = createSession({ id: "s1", user });
    session.variables.set("x", "outer");
    const io = makeIO();
    await interpreter.interpretLine("(x=inner; echo $x); echo $x", session, io);
    expect(await io.out.readAll()).toBe("inner\nouter\n");
  });

  it("redirects stdout to a file with > (truncate) and >> (append)", async () => {
    await machine.fs.mkdir("/tmp", ROOT_ACTOR);
    await machine.fs.chmod("/tmp", 0o777, ROOT_ACTOR);
    const session = createSession({ id: "s1", user, cwd: "/home/alice" });
    const io = makeIO();
    await interpreter.interpretLine("echo first > /tmp/out.txt", session, io);
    expect(await machine.fs.readFile("/tmp/out.txt", ROOT_ACTOR)).toBe("first\n");

    await interpreter.interpretLine("echo second >> /tmp/out.txt", session, makeIO());
    expect(await machine.fs.readFile("/tmp/out.txt", ROOT_ACTOR)).toBe("first\nsecond\n");

    await interpreter.interpretLine("echo third > /tmp/out.txt", session, makeIO());
    expect(await machine.fs.readFile("/tmp/out.txt", ROOT_ACTOR)).toBe("third\n");
  });

  it("redirects stdin from a file with <", async () => {
    await machine.fs.writeFile("/tmp/in.txt", "piped content", ROOT_ACTOR);
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    await interpreter.interpretLine("upper < /tmp/in.txt", session, io);
    expect(await io.out.readAll()).toBe("PIPED CONTENT");
  });

  it("resolves relative redirection targets against the session cwd", async () => {
    await machine.fs.mkdir("/home/alice", ROOT_ACTOR, true);
    await machine.fs.chown("/home/alice", user.uid, user.gid, ROOT_ACTOR);
    const session = createSession({ id: "s1", user, cwd: "/home/alice" });
    await interpreter.interpretLine("echo hi > note.txt", session, makeIO());
    expect(await machine.fs.readFile("/home/alice/note.txt", ROOT_ACTOR)).toBe("hi\n");
  });

  it("propagates CommandNotFoundError (exit code 127) for unknown commands", async () => {
    const session = createSession({ id: "s1", user });
    await expect(interpreter.interpretLine("doesnotexist", session, makeIO())).rejects.toBeInstanceOf(
      CommandNotFoundError,
    );
  });

  it("propagates PermissionError for a command whose policy denies the user", async () => {
    const session = createSession({ id: "s1", user });
    await expect(
      interpreter.interpretLine("shutdown --delay 5", session, makeIO()),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("lets root bypass any privilege policy", async () => {
    const session = createSession({ id: "s1", user: root });
    const io = makeIO();
    const code = await interpreter.interpretLine("shutdown --delay 3", session, io);
    expect(code).toBe(0);
    expect(machine.power.shutdownCalls).toEqual([3]);
  });

  it("catches ShellError thrown inside execute() and returns its exit code", async () => {
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    const code = await interpreter.interpretLine("fail", session, io);
    expect(code).toBe(2);
    expect(await io.err.readAll()).toContain("échec volontaire");
  });

  it("raises UsageError for a missing required argument", async () => {
    const session = createSession({ id: "s1", user });
    await expect(interpreter.interpretLine("cat", session, makeIO())).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("reads and concatenates multiple files via cat", async () => {
    await machine.fs.writeFile("/a.txt", "A", ROOT_ACTOR);
    await machine.fs.writeFile("/b.txt", "B", ROOT_ACTOR);
    const session = createSession({ id: "s1", user });
    const io = makeIO();
    await interpreter.interpretLine("cat /a.txt /b.txt", session, io);
    expect(await io.out.readAll()).toBe("A\nB\n");
  });
});
