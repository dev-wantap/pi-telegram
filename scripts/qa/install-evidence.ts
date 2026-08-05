import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Install command failed with exit ${exitCode}: ${stderr}`);
  }
  return `${stdout}${stderr}`.trim();
}

export async function collectInstallEvidence(packageRoot: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-install-qa-"));
  const senpiDirectory = join(root, "senpi");
  const ompDirectory = join(root, "omp");
  try {
    await Promise.all([
      mkdir(senpiDirectory, { recursive: true }),
      mkdir(ompDirectory, { recursive: true }),
    ]);
    const senpiOutput = await run(
      ["/opt/homebrew/bin/senpi", "install", packageRoot, "-l", "--approve"],
      senpiDirectory,
    );
    const senpiSettings = await readFile(join(senpiDirectory, ".senpi", "settings.json"), "utf8");
    const ompOutput = await run(
      ["/opt/homebrew/bin/omp", "plugin", "install", packageRoot, "--local", "--json"],
      ompDirectory,
    );
    return {
      senpiOutput,
      senpiSettings: JSON.parse(senpiSettings),
      ompManifest: JSON.parse(ompOutput),
      cleanup: "isolated install root removed in finally",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
