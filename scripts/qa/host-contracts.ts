import type { ExtensionFactory as SenpiExtensionFactory } from "@code-yeongyu/senpi";
import type { ExtensionFactory as PiExtensionFactory } from "@mariozechner/pi-coding-agent";
import extension from "../../src/index";

const piExtension: PiExtensionFactory = extension;
const senpiExtension: SenpiExtensionFactory = extension;

export const verifiedHostFactories = { piExtension, senpiExtension };
