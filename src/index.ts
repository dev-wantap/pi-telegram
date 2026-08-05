import type { ExtensionAPI as SenpiExtensionAPI } from "@code-yeongyu/senpi";
import type { ExtensionAPI as PiExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { logoutConfiguration, resolveConfiguration, saveConfiguration } from "./config";
import { promptSecretInput } from "./secret-input";
import { TelegramClient, TelegramClientError } from "./telegram-client";
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  ResolvedConfiguration,
  TelegramConfig,
  TelegramSendResult,
  ToolDefinition,
} from "./types";

const TEST_MESSAGE = "pi-telegram test message";
const NON_INTERACTIVE_GUIDANCE =
  "Interactive UI is required for /telegram-login. Configure PI_TELEGRAM_BOT_TOKEN and PI_TELEGRAM_CHAT_ID instead.";

interface BotInfo {
  readonly first_name: string;
  readonly username?: string | undefined;
}

interface ChatInfo {
  readonly id: number;
  readonly title?: string | undefined;
  readonly first_name?: string | undefined;
  readonly username?: string | undefined;
}

interface MessageInfo {
  readonly message_id: number;
}

export interface TelegramClientPort {
  getMe(signal?: AbortSignal): Promise<BotInfo>;
  getChat(chatId: string, signal?: AbortSignal): Promise<ChatInfo>;
  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<MessageInfo>;
}

export interface ExtensionDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly resolveConfiguration: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<ResolvedConfiguration | undefined>;
  readonly saveConfiguration: (configuration: TelegramConfig) => Promise<void>;
  readonly logoutConfiguration: () => Promise<void>;
  readonly promptSecret: (ui: NonNullable<CommandContext["ui"]>) => Promise<string | undefined>;
  readonly createClient: (token: string) => TelegramClientPort;
}

const productionDependencies: ExtensionDependencies = {
  environment: process.env,
  now: () => new Date(),
  resolveConfiguration,
  saveConfiguration: async (configuration) => saveConfiguration(configuration),
  logoutConfiguration: async () => logoutConfiguration(),
  promptSecret: promptSecretInput,
  createClient: (token) => new TelegramClient({ token }),
};

function errorMessage(error: unknown): string {
  return error instanceof TelegramClientError ? error.message : "Telegram operation failed";
}

function notify(
  context: CommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  context.ui?.notify(message, level);
}

function acceptsNoArguments(
  arguments_: string,
  context: CommandContext,
  commandName: string,
): boolean {
  if (arguments_.trim().length === 0) return true;
  notify(context, `Usage: /${commandName}`, "error");
  return false;
}

async function configured(
  dependencies: ExtensionDependencies,
  context: CommandContext,
): Promise<ResolvedConfiguration | undefined> {
  const configuration = await dependencies.resolveConfiguration(dependencies.environment);
  if (configuration === undefined) {
    notify(
      context,
      "Telegram is not configured. Run /telegram-login or set PI_TELEGRAM_BOT_TOKEN and PI_TELEGRAM_CHAT_ID.",
      "error",
    );
  }
  return configuration;
}

function chatLabel(chat: ChatInfo): string {
  if (chat.title !== undefined) return chat.title;
  if (chat.username !== undefined) return `@${chat.username}`;
  if (chat.first_name !== undefined) return chat.first_name;
  return String(chat.id);
}

export function createTelegramTool(
  dependencies: ExtensionDependencies,
): ToolDefinition<{ readonly text: string }, TelegramSendResult> {
  return {
    name: "telegram_send",
    label: "Send Telegram message",
    description:
      "Send a Telegram message only when the user explicitly requests it or project instructions require a completion notification. The configured recipient cannot be overridden.",
    parameters: Type.Object(
      {
        text: Type.String({
          description:
            "Message text, 1 to 4096 Unicode code points after entity parsing; this extension sends no entities.",
          minLength: 1,
          maxLength: 4096,
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, input, signal) => {
      try {
        const configuration = await dependencies.resolveConfiguration(dependencies.environment);
        if (configuration === undefined) {
          return {
            content: [{ type: "text", text: "Telegram send failed: Telegram is not configured." }],
            details: { sent: false, error: "Telegram is not configured." },
          };
        }
        const message = await dependencies
          .createClient(configuration.botToken)
          .sendMessage(configuration.chatId, input.text, signal);
        return {
          content: [{ type: "text", text: "Telegram message sent." }],
          details: { sent: true, messageId: message.message_id },
        };
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: "text", text: `Telegram send failed: ${message}` }],
          details: { sent: false, error: message },
        };
      }
    },
  };
}

export function createTelegramCommands(
  dependencies: ExtensionDependencies,
): Readonly<Record<string, CommandDefinition>> {
  return {
    "telegram-login": {
      description: "Configure a Telegram bot and target chat",
      handler: async (arguments_, context) => {
        if (!acceptsNoArguments(arguments_, context, "telegram-login")) return;
        if (
          (context.mode !== undefined && context.mode !== "tui") ||
          context.hasUI === false ||
          context.ui === undefined
        ) {
          notify(context, NON_INTERACTIVE_GUIDANCE, "error");
          return;
        }
        const token = await dependencies.promptSecret(context.ui);
        if (token === undefined) {
          notify(context, "Telegram login cancelled.", "warning");
          return;
        }
        try {
          const client = dependencies.createClient(token);
          const bot = await client.getMe();
          const botUsername = bot.username ?? bot.first_name;
          notify(
            context,
            `Connected bot: ${bot.username === undefined ? bot.first_name : `@${bot.username}`}`,
          );
          const chatId = await context.ui.input("Telegram Chat ID", "123456789 or @channel");
          if (chatId === undefined || chatId.length === 0) {
            notify(context, "Telegram login cancelled.", "warning");
            return;
          }
          const target = await client.getChat(chatId);
          notify(context, `Target: ${chatLabel(target)}`);
          const confirmed = await context.ui.confirm(
            "Confirm Telegram target",
            `Use ${bot.username === undefined ? bot.first_name : `@${bot.username}`} with ${chatLabel(target)}?`,
          );
          if (!confirmed) {
            notify(context, "Telegram login cancelled.", "warning");
            return;
          }
          if (await context.ui.confirm("Telegram", "Send a test message?")) {
            await client.sendMessage(String(target.id), TEST_MESSAGE);
          }
          await dependencies.saveConfiguration({
            version: 1,
            botToken: token,
            chatId: String(target.id),
            botUsername,
            updatedAt: dependencies.now().toISOString(),
          });
          notify(context, "Telegram configuration saved.");
        } catch (error) {
          notify(context, errorMessage(error), "error");
        }
      },
    },
    "telegram-status": {
      description: "Show Telegram configuration status",
      handler: async (arguments_, context) => {
        if (!acceptsNoArguments(arguments_, context, "telegram-status")) return;
        const configuration = await configured(dependencies, context);
        if (configuration === undefined) return;
        try {
          const client = dependencies.createClient(configuration.botToken);
          const bot = await client.getMe();
          const target = await client.getChat(configuration.chatId);
          const botLabel = bot.username === undefined ? bot.first_name : `@${bot.username}`;
          notify(
            context,
            `Telegram connected: ${botLabel} -> ${chatLabel(target)} (chat ${configuration.chatId}) via ${configuration.source}.`,
          );
        } catch (error) {
          notify(context, errorMessage(error), "error");
        }
      },
    },
    "telegram-test": {
      description: "Send a Telegram test message",
      handler: async (arguments_, context) => {
        if (!acceptsNoArguments(arguments_, context, "telegram-test")) return;
        const configuration = await configured(dependencies, context);
        if (configuration === undefined) return;
        try {
          await dependencies
            .createClient(configuration.botToken)
            .sendMessage(configuration.chatId, TEST_MESSAGE);
          notify(context, "Telegram test message sent.");
        } catch (error) {
          notify(context, errorMessage(error), "error");
        }
      },
    },
    "telegram-logout": {
      description: "Remove the local Telegram configuration file",
      handler: async (arguments_, context) => {
        if (!acceptsNoArguments(arguments_, context, "telegram-logout")) return;
        await dependencies.logoutConfiguration();
        notify(
          context,
          "Telegram configuration file removed. Environment variables are unchanged.",
        );
      },
    },
  };
}

export function createTelegramExtension(
  api: ExtensionAPI,
  dependencies: ExtensionDependencies = productionDependencies,
): void {
  for (const [name, definition] of Object.entries(createTelegramCommands(dependencies))) {
    api.registerCommand(name, definition);
  }
  api.registerTool(createTelegramTool(dependencies));
}

function telegramExtension(api: PiExtensionAPI): void;
function telegramExtension(api: SenpiExtensionAPI): void;
function telegramExtension(api: PiExtensionAPI | SenpiExtensionAPI): void {
  for (const [name, definition] of Object.entries(createTelegramCommands(productionDependencies))) {
    api.registerCommand(name, definition);
  }
  api.registerTool(createTelegramTool(productionDependencies));
}

export default telegramExtension;
