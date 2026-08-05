import { describe, expect, test } from "bun:test";
import {
  createTelegramCommands,
  createTelegramExtension,
  createTelegramTool,
  type ExtensionDependencies,
  type TelegramClientPort,
} from "../src/index";
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  TelegramConfig,
  TelegramSendResult,
  ToolDefinition,
  UserInterface,
} from "../src/types";

class FakeUi implements UserInterface {
  readonly notifications: Array<{ readonly message: string; readonly level?: string }> = [];
  readonly inputs: Array<string | undefined> = [];
  readonly confirmations: boolean[] = [];

  async input(): Promise<string | undefined> {
    return this.inputs.shift();
  }

  async confirm(): Promise<boolean> {
    return this.confirmations.shift() ?? false;
  }

  notify(message: string, level?: "info" | "warning" | "error"): void {
    this.notifications.push(level === undefined ? { message } : { message, level });
  }

  async custom<T>(): Promise<T> {
    throw new Error("Unexpected custom UI call");
  }
}

function createClient(
  sent: Array<{ readonly chatId: string; readonly text: string }>,
): TelegramClientPort {
  return {
    getMe: async () => ({
      id: 7,
      is_bot: true,
      first_name: "Notifier",
      username: "notify_bot",
    }),
    getChat: async () => ({
      id: 42,
      type: "private",
      first_name: "Kim",
    }),
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return {
        message_id: 9,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
        text,
      };
    },
  };
}

function createHarness(configuration?: TelegramConfig) {
  const sent: Array<{ readonly chatId: string; readonly text: string }> = [];
  const saved: TelegramConfig[] = [];
  let logoutCount = 0;
  let promptCount = 0;
  const dependencies: ExtensionDependencies = {
    environment: {},
    now: () => new Date("2026-08-04T00:00:00.000Z"),
    resolveConfiguration: async () =>
      configuration === undefined
        ? undefined
        : {
            botToken: configuration.botToken,
            chatId: configuration.chatId,
            botUsername: configuration.botUsername,
            source: "file",
          },
    saveConfiguration: async (value) => {
      saved.push(value);
    },
    logoutConfiguration: async () => {
      logoutCount += 1;
    },
    promptSecret: async () => {
      promptCount += 1;
      return "synthetic-secret-token";
    },
    createClient: () => createClient(sent),
  };
  return {
    dependencies,
    sent,
    saved,
    logoutCount: () => logoutCount,
    promptCount: () => promptCount,
  };
}

function configured(): TelegramConfig {
  return {
    version: 1,
    botToken: "synthetic-secret-token",
    chatId: "-100001",
    botUsername: "notify_bot",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

function tuiContext(ui: UserInterface): CommandContext {
  return { cwd: "/tmp/project", ui };
}

function command(
  commands: Readonly<Record<string, CommandDefinition>>,
  name: string,
): CommandDefinition {
  const found = commands[name];
  if (found === undefined) throw new Error(`Missing command ${name}`);
  return found;
}

describe("extension registration", () => {
  test("registers four commands and one token-free tool schema", () => {
    const harness = createHarness();
    const commands: string[] = [];
    const tools: string[] = [];
    const api: ExtensionAPI = {
      registerCommand: (name) => {
        commands.push(name);
      },
      registerTool: (definition) => {
        tools.push(definition.name);
      },
    };

    createTelegramExtension(api, harness.dependencies);
    expect(commands).toEqual([
      "telegram-login",
      "telegram-status",
      "telegram-test",
      "telegram-logout",
    ]);
    expect(tools).toEqual(["telegram_send"]);

    const schema = JSON.stringify(createTelegramTool(harness.dependencies).parameters);
    expect(schema).toContain('"text"');
    expect(schema).not.toContain("token");
    expect(schema).not.toContain("chatId");
  });

  test("tool refuses missing config and sends only to configured chat", async () => {
    const missing = createTelegramTool(createHarness().dependencies);
    const readyHarness = createHarness(configured());
    const ready = createTelegramTool(readyHarness.dependencies);
    const invalid = createTelegramTool({
      ...readyHarness.dependencies,
      resolveConfiguration: async () => {
        throw new Error("Invalid Telegram configuration file");
      },
    });
    const signal = new AbortController().signal;
    const context = { cwd: "/tmp/project" };

    const missingExecution = missing.execute(
      "call-1",
      { text: "done" },
      signal,
      undefined,
      context,
    );
    const sentResult = await ready.execute("call-2", { text: "done" }, signal, undefined, context);
    const invalidResult = await invalid.execute(
      "call-3",
      { text: "done" },
      signal,
      undefined,
      context,
    );

    await expect(missingExecution).resolves.toEqual({
      content: [{ type: "text", text: "Telegram send failed: Telegram is not configured." }],
      details: { sent: false, error: "Telegram is not configured." },
    });
    expect(sentResult).toEqual({
      content: [{ type: "text", text: "Telegram message sent." }],
      details: { sent: true, messageId: 9 },
    });
    expect(invalidResult).toEqual({
      content: [{ type: "text", text: "Telegram send failed: Telegram operation failed" }],
      details: { sent: false, error: "Telegram operation failed" },
    });
    expect(readyHarness.sent).toEqual([{ chatId: "-100001", text: "done" }]);
  });

  test("non-TUI login gives guidance without prompting", async () => {
    const modes: Array<NonNullable<CommandContext["mode"]>> = [
      "print",
      "rpc",
      "json",
      "app-server",
    ];
    for (const mode of modes) {
      const harness = createHarness();
      const commands = createTelegramCommands(harness.dependencies);
      const ui = new FakeUi();
      await command(commands, "telegram-login").handler("", {
        cwd: "/tmp/project",
        mode,
        hasUI: mode === "rpc",
        ui,
      });
      expect(harness.promptCount()).toBe(0);
      expect(ui.notifications[0]?.message).toContain("PI_TELEGRAM_BOT_TOKEN");
    }
  });

  test("login validates bot and chat, optionally tests, then saves", async () => {
    const harness = createHarness();
    const commands = createTelegramCommands(harness.dependencies);
    const ui = new FakeUi();
    ui.inputs.push("-100001");
    ui.confirmations.push(true, true);

    await command(commands, "telegram-login").handler("", tuiContext(ui));

    expect(harness.sent).toEqual([{ chatId: "42", text: "pi-telegram test message" }]);
    expect(harness.saved).toEqual([{ ...configured(), chatId: "42" }]);
    const transcript = JSON.stringify(ui.notifications);
    expect(transcript).toContain("@notify_bot");
    expect(transcript).toContain("Telegram configuration saved.");
    expect(transcript).not.toContain("synthetic-secret-token");
  });

  test("login does not save an unconfirmed bot and target", async () => {
    const harness = createHarness();
    const commands = createTelegramCommands(harness.dependencies);
    const ui = new FakeUi();
    ui.inputs.push("-100001");
    ui.confirmations.push(false);

    await command(commands, "telegram-login").handler("", tuiContext(ui));

    expect(harness.saved).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(JSON.stringify(ui.notifications)).toContain("login cancelled");
  });

  test("status, test, and logout remain token-free", async () => {
    const harness = createHarness(configured());
    const commands = createTelegramCommands(harness.dependencies);
    const ui = new FakeUi();
    const context = tuiContext(ui);

    await command(commands, "telegram-status").handler("", context);
    await command(commands, "telegram-test").handler("", context);
    await command(commands, "telegram-logout").handler("", context);

    expect(harness.sent).toEqual([{ chatId: "-100001", text: "pi-telegram test message" }]);
    expect(harness.logoutCount()).toBe(1);
    const transcript = JSON.stringify(ui.notifications);
    expect(transcript).toContain("@notify_bot");
    expect(transcript).toContain("Kim");
    expect(transcript).toContain("Telegram connected");
    expect(transcript).toContain("configuration file removed");
    expect(transcript).not.toContain("synthetic-secret-token");
  });

  test("every slash command rejects arguments without side effects", async () => {
    const harness = createHarness(configured());
    const commands = createTelegramCommands(harness.dependencies);
    const ui = new FakeUi();
    for (const name of ["telegram-login", "telegram-status", "telegram-test", "telegram-logout"]) {
      await command(commands, name).handler("unexpected", tuiContext(ui));
    }
    expect(harness.promptCount()).toBe(0);
    expect(harness.sent).toEqual([]);
    expect(harness.logoutCount()).toBe(0);
    expect(ui.notifications.every(({ message }) => message.startsWith("Usage: /telegram-"))).toBe(
      true,
    );
  });
});

const _compileTimeToolContract: ToolDefinition<{ readonly text: string }, TelegramSendResult> =
  createTelegramTool(createHarness().dependencies);
void _compileTimeToolContract;
