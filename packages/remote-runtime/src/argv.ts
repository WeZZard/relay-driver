/**
 * Bare-command resolution for the assigned remote environment (macOS arm64):
 * absolute argv passes through unchanged; bare names resolve against the
 * staged repo bin directory and the system PATH prefixes, and the child env
 * carries that PATH so shebangs find their interpreters.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

export async function resolveArgv(argv: readonly string[]): Promise<{ resolved: string[]; env: NodeJS.ProcessEnv }> {
  if (argv[0].includes("/")) return { resolved: [...argv], env: process.env };
  const BREW = "/opt/homebrew/bin";
  const STAGED_BIN = "/var/tmp/2026-09-09-21-51-38-Z-relay-driver-stage1/node_modules/.bin";
  let resolved = [...argv];
  for (const prefix of [STAGED_BIN, BREW, "/usr/local/bin", "/usr/bin"]) {
    try {
      await stat(join(prefix, argv[0]));
      resolved = [join(prefix, argv[0]), ...argv.slice(1)];
      break;
    } catch { /* try next */ }
  }
  const envPath = [STAGED_BIN, BREW, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return { resolved, env: { ...process.env, PATH: envPath } };
}
