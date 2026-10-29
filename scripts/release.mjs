import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
process.chdir(root);
const capture = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const read = (name) => JSON.parse(readFileSync(name, "utf8"));
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const identity = (url) => {
  const match = /^(?:git\+https:\/\/|https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url ?? "");
  assert(match, "Set repository.url and origin to the actual GitHub repository");
  return match[1].toLowerCase();
};
try {
  const [kind = "current", flag, ...extra] = process.argv.slice(2);
  assert(["current", "patch", "minor", "major"].includes(kind) && (!flag || flag === "--execute") && !extra.length, "Usage: npm run release -- current|patch|minor|major [--execute]");
  const p = read("package.json");
  const lock = read("package-lock.json");
  assert.equal(p.name, "pi-copy-picker", "wrong package name");
  assert(stable.test(p.version), "stable versions only");
  for (const entry of [lock, lock.packages[""]]) {
    assert.equal(entry.version, p.version, "lock version mismatch");
    assert.equal(entry.name, p.name, "lock name mismatch");
  }
  assert.equal(realpathSync(capture("git", ["rev-parse", "--show-toplevel"])), root, "run from the real repository root");
  assert.equal(capture("git", ["branch", "--show-current"]), "main", "release requires main");
  assert.equal(capture("git", ["status", "--porcelain"]), "", "working tree must be clean");
  const repository = identity(p.repository?.url);
  for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
    const urls = capture("git", args).split("\n");
    assert.equal(urls.length, 1, "origin must have exactly one URL");
    assert.equal(identity(urls[0]), repository, "repository must match origin");
  }
  const head = capture("git", ["rev-parse", "HEAD"]);
  assert.equal(capture("git", ["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0], head, "HEAD must equal remote main");
  const parts = p.version.split(".").map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[kind];
  if (index !== undefined) {
    parts[index]++;
    parts.fill(0, index + 1);
  }
  const version = parts.join(".");
  const tag = `v${version}`;
  assert.equal(capture("git", ["tag", "--list", tag]), "", "tag already exists locally");
  assert.equal(capture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]), "", "tag already exists remotely");
  run("npm", ["run", "check"]);
  assert.equal(capture("git", ["status", "--porcelain"]), "", "checks changed the working tree");
  assert.equal(capture("git", ["rev-parse", "HEAD"]), head, "HEAD changed during checks");
  console.log(`Preflight passed for ${tag}. No publication or push performed.`);
  if (flag !== "--execute") {
    console.log("Dry run only. Use --execute to create the local version commit and tag.");
  } else {
    if (kind !== "current") {
      run("npm", ["version", version, "--no-git-tag-version", "--ignore-scripts"]);
      run("npm", ["run", "check"]);
      run("git", ["add", "--", "package.json", "package-lock.json"]);
      run("git", ["commit", "-m", `release: v${version}`]);
    }
    assert.equal(capture("git", ["status", "--porcelain"]), "", "working tree must be clean before tagging");
    run("git", ["tag", "-a", tag, "-m", `Release ${version}`]);
    console.log(`Created local ${tag}. Review it before an atomic push. CI, not this helper, publishes to npm.`);
  }
} catch (error) {
  console.error(`Release aborted: ${error.message}`);
  process.exitCode = 1;
}
