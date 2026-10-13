// Prepares a release: sets the app's version, commits it and tags it. Pushing the tag starts
// .github/workflows/release.yml, which builds the installers and publishes them.
// Run after a green `npm run verify`: npm run release -- 0.2.0
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: npm run release -- 0.2.0");
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain")) {
  console.error("Commit or stash the changes first: a release is made from a clean tree.");
  process.exit(1);
}

const file = join(root, "apps/desktop/package.json");
const pkg = JSON.parse(readFileSync(file, "utf8"));
if (pkg.version === version) {
  console.error(`The app is already at ${version}.`);
  process.exit(1);
}
pkg.version = version;
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
git("add", "apps/desktop/package.json", "package-lock.json");
git("commit", "-q", "-m", `Release ${version}`);
git("tag", `v${version}`);
console.log(`Tagged v${version}. Publish it: git push && git push origin v${version}`);
