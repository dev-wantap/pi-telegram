import { z } from "zod";
import { createTelegramCommands, createTelegramTool } from "../../src/index";
import { TelegramClient, TelegramClientError } from "../../src/telegram-client";
import type { CommandDefinition, ResolvedConfiguration, UserInterface } from "../../src/types";

const bodySchema = z
  .object({ chat_id: z.string().optional(), text: z.string().optional() })
  .passthrough();

class EvidenceUi implements UserInterface {
  readonly notifications: string[] = [];

  async input(): Promise<string | undefined> {
    return undefined;
  }

  async confirm(): Promise<boolean> {
    return false;
  }

  notify(message: string): void {
    this.notifications.push(message);
  }

  async custom<T>(): Promise<T> {
    throw new Error("Unexpected custom UI call");
  }
}

function command(
  commands: Readonly<Record<string, CommandDefinition>>,
  name: string,
): CommandDefinition {
  const definition = commands[name];
  if (definition === undefined) throw new Error(`Missing command ${name}`);
  return definition;
}

function sanitized(error: unknown, secret: string): boolean {
  return (
    error instanceof TelegramClientError &&
    !error.message.includes(secret) &&
    !error.message.includes("http")
  );
}

async function rejects(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

export async function collectLiveNetworkEvidence() {
  const requests: Array<{
    readonly method: string;
    readonly body: z.infer<typeof bodySchema>;
  }> = [];
  const attempts = new Map<string, number>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const segments = url.pathname.split("/");
      const token = segments[1]?.startsWith("bot") === true ? segments[1].slice(3) : "";
      const method = segments[2] ?? "";
      const body = bodySchema.parse(await request.json());
      requests.push({ method, body });
      const key = `${token}:${method}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);

      if (token === "forbidden-secret") {
        return Response.json(
          { ok: false, error_code: 403, description: "Forbidden" },
          { status: 403 },
        );
      }
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: { id: 7, is_bot: true, first_name: "Notifier", username: "qa_bot" },
        });
      }
      if (method === "getChat") {
        return Response.json({
          ok: true,
          result: { id: 42, type: "private", first_name: "Kim" },
        });
      }
      return Response.json({
        ok: true,
        result: {
          message_id: 91,
          date: 1_700_000_000,
          chat: { id: 42, type: "private" },
          text: body.text,
        },
      });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const secret = "live-client-secret";

  try {
    const client = new TelegramClient({ token: secret, baseUrl });
    const bot = await client.getMe();
    const chat = await client.getChat("-100001");
    const directMessage = await client.sendMessage("-100001", "direct");
    await client.sendMessage("-100001", "x");
    await client.sendMessage("-100001", "😀".repeat(4096));
    const emptyRejected = await rejects(() => client.sendMessage("-100001", ""));
    const oversizedRejected = await rejects(() => client.sendMessage("-100001", "x".repeat(4097)));
    const dependencies = {
      environment: {},
      now: () => new Date("2026-08-04T00:00:00.000Z"),
      resolveConfiguration: async (): Promise<ResolvedConfiguration> => ({
        botToken: secret,
        chatId: "-100001",
        botUsername: "qa_bot",
        source: "file",
      }),
      saveConfiguration: async () => undefined,
      logoutConfiguration: async () => undefined,
      promptSecret: async () => undefined,
      createClient: () => new TelegramClient({ token: secret, baseUrl }),
    };
    const signal = new AbortController().signal;
    const toolResult = await createTelegramTool(dependencies).execute(
      "qa-tool",
      { text: "tool" },
      signal,
      undefined,
      { cwd: process.cwd() },
    );
    const ui = new EvidenceUi();
    await command(createTelegramCommands(dependencies), "telegram-test").handler("", {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      ui,
    });
    await command(createTelegramCommands(dependencies), "telegram-status").handler("", {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      ui,
    });
    const nonTuiUi = new EvidenceUi();
    await command(createTelegramCommands(dependencies), "telegram-login").handler("", {
      cwd: process.cwd(),
      mode: "rpc",
      hasUI: true,
      ui: nonTuiUi,
    });
    const missingDependencies = {
      ...dependencies,
      resolveConfiguration: async () => undefined,
    };
    const missingResult = await createTelegramTool(missingDependencies).execute(
      "qa-missing",
      { text: "tool" },
      signal,
      undefined,
      { cwd: process.cwd() },
    );
    const missingConfigRefused =
      missingResult.details?.sent === false &&
      missingResult.details.error === "Telegram is not configured.";

    const forbiddenSecret = "forbidden-secret";
    let forbiddenError: unknown;
    try {
      await new TelegramClient({ token: forbiddenSecret, baseUrl }).getMe();
    } catch (error) {
      forbiddenError = error;
    }
    const cancelled = new AbortController();
    cancelled.abort();
    let cancellationError: unknown;
    try {
      await client.getMe(cancelled.signal);
    } catch (error) {
      cancellationError = error;
    }
    const timeout = new AbortController();
    timeout.abort();
    let timeoutError: unknown;
    try {
      await new TelegramClient({
        token: secret,
        baseUrl,
        createTimeoutSignal: () => timeout.signal,
      }).getMe();
    } catch (error) {
      timeoutError = error;
    }

    return {
      serverSurface: "Bun.serve HTTP",
      methods: requests.map(({ method }) => method),
      getMeUsername: bot.username,
      getChatName: chat.first_name,
      directMessageId: directMessage.message_id,
      toolSent: toolResult.details?.sent,
      commandNotification: ui.notifications[0],
      statusNotification: ui.notifications[1],
      missingConfigRefused,
      nonTuiGuidance: nonTuiUi.notifications[0],
      emptyRejected,
      oversizedRejected,
      oneCodePointAccepted: true,
      fourThousandNinetySixCodePointsAccepted: true,
      configuredRecipients: requests
        .map(({ body }) => body.chat_id)
        .filter((chatId) => chatId !== undefined),
      ordinary4xxAttempts: attempts.get(`${forbiddenSecret}:getMe`),
      ordinary4xxSanitized: sanitized(forbiddenError, forbiddenSecret),
      cancellationSanitized: sanitized(cancellationError, secret),
      timeoutSanitized: sanitized(timeoutError, secret),
      cleanup: "server stopped in finally",
    };
  } finally {
    await server.stop(true);
  }
}
