#!/usr/bin/env node
/**
 * Set the release version across all five published packages, refresh the
 * lockfile, and commit + tag the release. Never pushes — that's a separate,
 * explicit step (see the README's Releasing section).
 *
 * Usage: node scripts/bump.mjs <X.Y.Z>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = ["core", "host-sdk", "remote-runtime", "script-sdk", "cli"];
const SCOPE = "@wezzard/relay-driver-";

// Full semver core plus optional pre-release/build metadata (semver.org).
const SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
}

function fail(message) {
  console.error(`bump: ${message}`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) fail("usage: node scripts/bump.mjs <X.Y.Z>");
if (!SEMVER_RE.test(version)) {
  fail(`"${version}" is not a valid semantic version (expected X.Y.Z, e.g. 0.2.0)`);
}

const status = run("git", ["status", "--porcelain"]).trim();
if (status.length > 0) {
  fail("working tree is not clean; commit or stash pending changes before bumping");
}

const relativePaths = PACKAGES.map((name) => join("packages", name, "package.json"));

for (const relativePath of relativePaths) {
  const path = join(ROOT, relativePath);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.version = version;
  if (data.dependencies) {
    for (const dep of Object.keys(data.dependencies)) {
      if (dep.startsWith(SCOPE)) data.dependencies[dep] = `^${version}`;
    }
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

run("npm", ["install", "--package-lock-only"]);

run("git", ["add", "package-lock.json", ...relativePaths]);
run("git", ["commit", "-m", `Release v${version}`]);
run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);

console.log(`bump: committed and tagged v${version} (not pushed — run: git push --follow-tags)`);
