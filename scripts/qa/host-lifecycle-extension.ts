import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ExtensionDependencies, TelegramClientPort } from "../../src/index";
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  ResolvedConfiguration,
  TelegramConfig,
  UserInterface,
} from "../../src/types";

const production = (await import(
  new URL("../../dist/index.js", import.meta.url).href
)) as typeof import("../../src/index");
const { createTelegramCommands, createTelegramTool } = production;
const configurationSchema = z.object({
  version: z.literal(1),
  botToken: z.string(),
  chatId: z.string(),
  botUsername: z.string().optional(),
  updatedAt: z.string(),
});

function configurationPath(): string {
  const { PI_TELEGRAM_CONFIG: path } = process.env;
  if (path === undefined) throw new Error("PI_TELEGRAM_CONFIG is required for lifecycle QA");
  return path;
}

async function resolveFixtureConfiguration(): Promise<ResolvedConfiguration | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(configurationPath(), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const configuration = configurationSchema.parse(JSON.parse(serialized));
  return {
    botToken: configuration.botToken,
    chatId: configuration.chatId,
    source: "file",
    ...(configuration.botUsername === undefined ? {} : { botUsername: configuration.botUsername }),
  };
}

async function saveFixtureConfiguration(configuration: TelegramConfig): Promise<void> {
  const path = configurationPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`);
  await chmod(path, 0o600);
}

async function logoutFixtureConfiguration(): Promise<void> {
  await rm(configurationPath(), { force: true });
}

class FixtureClient implements TelegramClientPort {
  sendCount = 0;

  async getMe() {
    return { first_name: "Fixture", username: "fixture_bot" };
  }

  async getChat() {
    return { id: -1_004_242, first_name: "Fixture Target" };
  }

  async sendMessage(_chatId: string, _text: string) {
    this.sendCount += 1;
    return { message_id: this.sendCount };
  }
}

class FixtureUi implements UserInterface {
  readonly notifications: string[] = [];
  readonly confirmations: boolean[];

  constructor(confirmations: boolean[] = []) {
    this.confirmations = confirmations;
  }

  async input(): Promise<string> {
    return "@fixture_target";
  }

  async confirm(): Promise<boolean> {
    return this.confirmations.shift() ?? false;
  }

  notify(message: string): void {
    this.notifications.push(message);
  }

  async custom<T>(): Promise<T> {
    throw new Error("Fixture injects a synthetic token without opening custom UI");
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

function dependencies(client: FixtureClient): ExtensionDependencies {
  return {
    environment: process.env,
    now: () => new Date("2026-08-04T00:00:00.000Z"),
    resolveConfiguration: resolveFixtureConfiguration,
    saveConfiguration: saveFixtureConfiguration,
    logoutConfiguration: logoutFixtureConfiguration,
    promptSecret: async () => "fixture-secret",
    createClient: () => client,
  };
}

function context(ui: UserInterface): CommandContext {
  return { cwd: process.cwd(), mode: "tui", hasUI: true, ui };
}

export default function hostLifecycleExtension(api: ExtensionAPI): void {
  api.registerCommand("telegram-qa-setup", {
    description: "QA: validate, confirm, test, and persist Telegram configuration",
    handler: async (_arguments, hostContext) => {
      const client = new FixtureClient();
      const fixtureUi = new FixtureUi([true, true]);
      await command(createTelegramCommands(dependencies(client)), "telegram-login").handler(
        "",
        context(fixtureUi),
      );
      const configuration = await resolveFixtureConfiguration();
      hostContext.ui?.notify(
        `QA setup saved=${configuration?.chatId === "-1004242"} sends=${client.sendCount}`,
        "warning",
      );
    },
  });

  api.registerCommand("telegram-qa-restart", {
    description: "QA: verify persisted status/test, logout, and tool refusal",
    handler: async (_arguments, hostContext) => {
      const client = new FixtureClient();
      const fixtureDependencies = dependencies(client);
      const fixtureUi = new FixtureUi();
      const commands = createTelegramCommands(fixtureDependencies);
      await command(commands, "telegram-status").handler("", context(fixtureUi));
      await command(commands, "telegram-test").handler("", context(fixtureUi));
      await command(commands, "telegram-logout").handler("", context(fixtureUi));
      const toolResult = await createTelegramTool(fixtureDependencies).execute(
        "qa-after-logout",
        { text: "must fail" },
        new AbortController().signal,
        undefined,
        { cwd: process.cwd() },
      );
      const toolRefused = toolResult.details?.sent === false;
      hostContext.ui?.notify(
        `QA restart connected=${fixtureUi.notifications.some((message) => message.startsWith("Telegram connected:"))} tested=${client.sendCount === 1} loggedOut=${fixtureUi.notifications.some((message) => message.includes("file removed"))} toolRefused=${toolRefused}`,
        "warning",
      );
    },
  });
}
