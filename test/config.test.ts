import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  logoutConfiguration,
  resolveConfiguration,
  saveConfiguration,
} from "../src/config";
import type { TelegramConfig } from "../src/types";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-telegram-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function environment(root: string, overrides: Record<string, string | undefined> = {}) {
  return { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), ...overrides };
}

function config(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    version: 1,
    botToken: "file-token-secret",
    chatId: "-1000012345678",
    botUsername: "notification_bot",
    updatedAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

async function writeConfig(root: string, value: unknown): Promise<void> {
  const path = getConfigPath(environment(root));
  await mkdir(join(root, "xdg", "pi-telegram"), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("configuration paths and resolution", () => {
  test("resolves custom, XDG, and HOME paths", async () => {
    const root = await temporaryDirectory();
    expect(
      getConfigPath(environment(root, { PI_TELEGRAM_CONFIG: join(root, "custom.json") })),
    ).toBe(join(root, "custom.json"));
    expect(getConfigPath(environment(root))).toBe(join(root, "xdg", "pi-telegram", "config.json"));
    expect(getConfigPath({ HOME: join(root, "home") })).toBe(
      join(root, "home", ".config", "pi-telegram", "config.json"),
    );
  });

  test("gives a complete environment pair precedence over file", async () => {
    const root = await temporaryDirectory();
    await writeConfig(root, config());
    expect(
      await resolveConfiguration(
        environment(root, {
          PI_TELEGRAM_BOT_TOKEN: "environment-token-secret",
          PI_TELEGRAM_CHAT_ID: "-1000098765432",
        }),
      ),
    ).toEqual({
      botToken: "environment-token-secret",
      chatId: "-1000098765432",
      source: "environment",
    });
  });

  test("rejects mutable usernames from environment and files", async () => {
    const root = await temporaryDirectory();
    await expect(
      resolveConfiguration(
        environment(root, {
          PI_TELEGRAM_BOT_TOKEN: "environment-token-secret",
          PI_TELEGRAM_CHAT_ID: "@release_channel",
        }),
      ),
    ).rejects.toThrow("numeric");
    await writeConfig(root, config({ chatId: "@release_channel" }));
    await expect(resolveConfiguration(environment(root))).rejects.toThrow(
      "Invalid Telegram configuration file",
    );
  });

  test("never merges a partial environment pair with file secrets", async () => {
    const root = await temporaryDirectory();
    await writeConfig(root, config());
    expect(
      await resolveConfiguration(
        environment(root, { PI_TELEGRAM_BOT_TOKEN: "environment-token-secret" }),
      ),
    ).toEqual({
      botToken: "file-token-secret",
      chatId: "-1000012345678",
      botUsername: "notification_bot",
      source: "file",
    });
  });

  test("rejects numeric chatId without leaking the token in the error", async () => {
    const root = await temporaryDirectory();
    const secret = "must-not-appear-in-errors";
    await writeConfig(root, { ...config({ botToken: secret }), chatId: 123456789 });
    let error: unknown;
    try {
      await resolveConfiguration(environment(root));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
  });

  test("returns undefined for a partial environment pair when no file exists", async () => {
    const root = await temporaryDirectory();
    expect(
      await resolveConfiguration(environment(root, { PI_TELEGRAM_CHAT_ID: "no-token" })),
    ).toBeUndefined();
  });
});

describe("configuration storage", () => {
  test("atomically saves JSON with private directory and file modes", async () => {
    const root = await temporaryDirectory();
    const env = environment(root);
    const path = getConfigPath(env);
    const directory = join(root, "xdg", "pi-telegram");
    await saveConfiguration(config(), env);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["config.json"]);
  });

  test("preserves an existing custom parent directory mode", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "shared");
    const path = join(directory, "telegram.json");
    await mkdir(directory, { mode: 0o755 });
    await saveConfiguration(config(), { PI_TELEGRAM_CONFIG: path });
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("cleans up its same-directory temporary file after failed rename", async () => {
    const root = await temporaryDirectory();
    const env = environment(root);
    const path = getConfigPath(env);
    const directory = join(root, "xdg", "pi-telegram");
    await mkdir(path, { recursive: true });
    let error: unknown;
    try {
      await saveConfiguration(config(), env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(await readdir(directory)).toEqual(["config.json"]);
  });

  test("repairs an existing configuration directory mode", async () => {
    const root = await temporaryDirectory();
    const env = environment(root);
    const directory = join(root, "xdg", "pi-telegram");
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);
    await saveConfiguration(config(), env);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  test("logout deletes only config.json and treats missing as success", async () => {
    const root = await temporaryDirectory();
    const env = environment(root);
    const directory = join(root, "xdg", "pi-telegram");
    await saveConfiguration(config(), env);
    await writeFile(join(directory, "keep.txt"), "keep", "utf8");
    await logoutConfiguration(env);
    await logoutConfiguration(env);
    expect(await readdir(directory)).toEqual(["keep.txt"]);
  });
});
