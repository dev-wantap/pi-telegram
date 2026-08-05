import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ResolvedConfiguration, TelegramConfig } from "./types";

type ConfigurationEnvironment = Readonly<Record<string, string | undefined>>;

const numericChatIdSchema = z
  .string()
  .regex(/^-?\d+$/, "Telegram Chat ID must be a numeric user, group, or channel ID");
const telegramConfigSchema = z
  .object({
    version: z.literal(1),
    botToken: z.string().min(1),
    chatId: numericChatIdSchema,
    botUsername: z.string().min(1),
    updatedAt: z.iso.datetime(),
  })
  .strict();

function environmentValue(environment: ConfigurationEnvironment, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function getConfigPath(environment: ConfigurationEnvironment = process.env): string {
  const customPath = environmentValue(environment, "PI_TELEGRAM_CONFIG");
  if (customPath !== undefined) return customPath;

  if (process.platform === "win32") {
    const appData = environmentValue(environment, "APPDATA");
    if (appData !== undefined) return join(appData, "pi-telegram", "config.json");
  }

  const configHome = environmentValue(environment, "XDG_CONFIG_HOME");
  if (configHome !== undefined) return join(configHome, "pi-telegram", "config.json");

  const home = environmentValue(environment, "HOME") ?? homedir();
  return join(home, ".config", "pi-telegram", "config.json");
}

function parseConfiguration(contents: string): TelegramConfig {
  try {
    return telegramConfigSchema.parse(JSON.parse(contents));
  } catch {
    throw new Error("Invalid Telegram configuration file");
  }
}

export async function resolveConfiguration(
  environment: ConfigurationEnvironment = process.env,
): Promise<ResolvedConfiguration | undefined> {
  const botToken = environmentValue(environment, "PI_TELEGRAM_BOT_TOKEN");
  const chatId = environmentValue(environment, "PI_TELEGRAM_CHAT_ID");
  if (botToken !== undefined && chatId !== undefined) {
    const numericChatId = numericChatIdSchema.safeParse(chatId);
    if (!numericChatId.success) {
      throw new Error("Telegram Chat ID must be a numeric user, group, or channel ID");
    }
    return { botToken, chatId: numericChatId.data, source: "environment" };
  }

  let contents: string;
  try {
    contents = await readFile(getConfigPath(environment), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }

  const configuration = parseConfiguration(contents);
  return {
    botToken: configuration.botToken,
    chatId: configuration.chatId,
    botUsername: configuration.botUsername,
    source: "file",
  };
}

export async function saveConfiguration(
  configuration: TelegramConfig,
  environment: ConfigurationEnvironment = process.env,
): Promise<void> {
  let validated: TelegramConfig;
  try {
    validated = telegramConfigSchema.parse(configuration);
  } catch {
    throw new Error("Invalid Telegram configuration");
  }

  const path = getConfigPath(environment);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.config.json.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (environmentValue(environment, "PI_TELEGRAM_CONFIG") === undefined) {
    await chmod(directory, 0o700);
  }

  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function logoutConfiguration(
  environment: ConfigurationEnvironment = process.env,
): Promise<void> {
  await rm(getConfigPath(environment), { force: true });
}
