import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  getConfigPath,
  logoutConfiguration,
  resolveConfiguration,
  saveConfiguration,
} from "../../src/config";
import { createTelegramExtension, createTelegramTool } from "../../src/index";
import { createSecretInputComponent } from "../../src/secret-input";
import { TelegramClient } from "../../src/telegram-client";
import type { ExtensionAPI, TelegramConfig } from "../../src/types";
import { collectInstallEvidence } from "./install-evidence";
import { collectLiveNetworkEvidence } from "./live-network-evidence";

const SYNTHETIC_TOKEN = "qa-synthetic-secret-token";
const reportDirectory = join(process.cwd(), "artifacts", "qa");
const bodySchema = z
  .object({ chat_id: z.string().optional(), text: z.string().optional() })
  .passthrough();

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function queuedFetch(
  responses: readonly Response[],
  requests: Array<z.infer<typeof bodySchema>>,
): FetchFunction {
  let index = 0;
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(bodySchema.parse(await request.clone().json()));
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error("Unexpected QA request");
    return next;
  };
}

async function securityEvidence(root: string) {
  const environment = { XDG_CONFIG_HOME: root };
  const configuration: TelegramConfig = {
    version: 1,
    botToken: SYNTHETIC_TOKEN,
    chatId: "-100001",
    botUsername: "qa_bot",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
  await saveConfiguration(configuration, environment);
  await saveConfiguration({ ...configuration, updatedAt: "2026-08-04T00:00:01.000Z" }, environment);
  const path = getConfigPath(environment);
  const filesAfterSave = await readdir(join(root, "pi-telegram"));
  const directoryMode = (await stat(join(root, "pi-telegram"))).mode & 0o777;
  const fileMode = (await stat(path)).mode & 0o777;
  const resolved = await resolveConfiguration(environment);

  let completed = false;
  let bulletRender = "";
  const component = createSecretInputComponent(
    "Telegram Bot Token",
    { requestRender: () => undefined },
    { fg: (_color, text) => text },
    () => {
      completed = true;
    },
  );
  component.handleInput(SYNTHETIC_TOKEN);
  bulletRender = component.render(80).join("\n");
  component.handleInput("\r");

  const environmentResolved = await resolveConfiguration({
    ...environment,
    PI_TELEGRAM_BOT_TOKEN: "environment-secret",
    PI_TELEGRAM_CHAT_ID: "-100002",
  });
  await logoutConfiguration(environment);
  const filesAfterLogout = await readdir(join(root, "pi-telegram"));

  return {
    resolvedSource: resolved?.source,
    resolvedChatId: resolved?.chatId,
    environmentSource: environmentResolved?.source,
    environmentChatId: environmentResolved?.chatId,
    directoryMode: directoryMode.toString(8),
    fileMode: fileMode.toString(8),
    replacementCompletedWithoutTempArtifacts:
      filesAfterSave.length === 1 && filesAfterSave[0] === "config.json",
    bulletCount: [...bulletRender].filter((character) => character === "•").length,
    rawSecretVisible: bulletRender.includes(SYNTHETIC_TOKEN),
    completed,
    filesAfterLogout,
    cleanup: "temporary root removed in finally",
  };
}

async function networkEvidence() {
  const requests: Array<z.infer<typeof bodySchema>> = [];
  const delays: number[] = [];
  const message = {
    message_id: 91,
    date: 1_700_000_000,
    chat: { id: 42, type: "private" },
    text: "done",
  };
  const client = new TelegramClient({
    token: SYNTHETIC_TOKEN,
    baseUrl: "https://telegram.qa",
    fetch: queuedFetch(
      [
        response(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 3 },
          },
          429,
        ),
        response({ ok: true, result: message }),
      ],
      requests,
    ),
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  const sent = await client.sendMessage("-100001", "done");

  const serverRequests: Array<z.infer<typeof bodySchema>> = [];
  const serverDelays: number[] = [];
  const unavailable = { ok: false, error_code: 500, description: "Unavailable" };
  const serverClient = new TelegramClient({
    token: SYNTHETIC_TOKEN,
    fetch: queuedFetch(
      [
        response(unavailable, 500),
        response(unavailable, 503),
        response({
          ok: true,
          result: { id: 7, is_bot: true, first_name: "Notifier", username: "qa_bot" },
        }),
      ],
      serverRequests,
    ),
    sleep: async (milliseconds) => {
      serverDelays.push(milliseconds);
    },
  });
  const bot = await serverClient.getMe();

  return {
    sendMessageId: sent.message_id,
    configuredChatId: requests[1]?.chat_id,
    rateLimitAttempts: requests.length,
    rateLimitDelaysMs: delays,
    serverAttempts: serverRequests.length,
    serverDelaysMs: serverDelays,
    botUsername: bot.username,
    cleanup: "mock fetch queues exhausted; no server process created",
  };
}

function registrationEvidence() {
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
  const dependencies = {
    environment: {},
    now: () => new Date("2026-08-04T00:00:00.000Z"),
    resolveConfiguration: async () => undefined,
    saveConfiguration: async () => undefined,
    logoutConfiguration: async () => undefined,
    promptSecret: async () => undefined,
    createClient: () => new TelegramClient({ token: SYNTHETIC_TOKEN }),
  };
  createTelegramExtension(api, dependencies);
  const schema = createTelegramTool(dependencies).parameters;
  return { commands, tools, schema };
}

async function packageEvidence(): Promise<string> {
  const child = Bun.spawn(["bun", "pm", "pack", "--dry-run"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error("Package dry run failed");
  return `${stdout}${stderr}`;
}

async function main(): Promise<void> {
  await mkdir(reportDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-telegram-qa-"));
  try {
    const security = await securityEvidence(temporaryRoot);
    const network = { ...(await networkEvidence()), live: await collectLiveNetworkEvidence() };
    const registration = registrationEvidence();
    const install = await collectInstallEvidence(process.cwd());
    const packageReport = await packageEvidence();
    const reports = {
      "security-report.json": security,
      "network-report.json": network,
      "host-registration.json": registration,
      "install-report.json": install,
    };
    const serialized = JSON.stringify(reports);
    if (serialized.includes(SYNTHETIC_TOKEN)) throw new Error("Synthetic token leaked");
    await Promise.all(
      Object.entries(reports).map(([name, value]) =>
        Bun.write(join(reportDirectory, name), `${JSON.stringify(value, null, 2)}\n`),
      ),
    );
    await Bun.write(
      join(reportDirectory, "security-transcript.txt"),
      `source=${security.resolvedSource}\nchatId=${security.resolvedChatId}\ndirectoryMode=${security.directoryMode}\nfileMode=${security.fileMode}\nbullets=${security.bulletCount}\nsecretScan=0\n`,
    );
    await Bun.write(
      join(reportDirectory, "network-transcript.txt"),
      `429 attempts=${network.rateLimitAttempts} delays=${network.rateLimitDelaysMs.join(",")}\n5xx attempts=${network.serverAttempts} delays=${network.serverDelaysMs.join(",")}\ncleanup=${network.cleanup}\n`,
    );
    await Bun.write(join(reportDirectory, "package-report.txt"), packageReport);
    console.log(`QA evidence written to ${reportDirectory}; synthetic secret scan: 0`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
