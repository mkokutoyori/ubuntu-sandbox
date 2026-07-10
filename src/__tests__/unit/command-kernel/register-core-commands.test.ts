import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@/command-kernel/registry/command-registry";
import { registerCoreCommands } from "@/command-kernel/register-core-commands";
import { Interpreter } from "@/command-kernel/interpreter";
import { createSession, SimpleUser } from "@/command-kernel/session/types";
import { InMemoryMachine } from "@/command-kernel/testing/in-memory-machine";
import { PipeBuffer } from "@/command-kernel/io/pipe-buffer";

describe("registerCoreCommands", () => {
  it("registers exit and echo, resoluble by any equipment bootstrap", () => {
    const registry = new CommandRegistry();
    registerCoreCommands(registry);
    expect(registry.has("exit")).toBe(true);
    expect(registry.has("echo")).toBe(true);
  });

  it("echo writes its words with a trailing newline, or none with -n", async () => {
    const registry = new CommandRegistry();
    registerCoreCommands(registry);
    const machine = new InMemoryMachine("sandbox");
    const interpreter = new Interpreter(registry, machine);
    const session = createSession({ id: "s1", user: new SimpleUser(1000, 1000, "alice") });
    const out = new PipeBuffer();
    const io = { stdin: new PipeBuffer(), stdout: out, stderr: new PipeBuffer() };

    await interpreter.interpretLine("echo hello world", session, io);
    expect(await out.readAll()).toBe("hello world\n");

    const out2 = new PipeBuffer();
    await interpreter.interpretLine("echo -n hi", session, { ...io, stdout: out2 });
    expect(await out2.readAll()).toBe("hi");
  });
});
