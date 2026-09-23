/**
 * Shared helper for the host-sdk examples: every example that drives a real
 * remote machine over SSH reads the target from the environment. There is no
 * private default — set RELAY_SSH_HOST before running an example.
 */
export function requireTarget(): string {
  const target = process.env.RELAY_SSH_HOST;
  if (!target) {
    throw new Error(
      "RELAY_SSH_HOST is not set. This example connects to a real remote " +
        "host over SSH; set RELAY_SSH_HOST=user@host (e.g. " +
        "RELAY_SSH_HOST=user@192.0.2.10) before running it.",
    );
  }
  return target;
}
