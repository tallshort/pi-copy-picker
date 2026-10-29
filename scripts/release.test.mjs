import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const scenario of ["no git", "wrong version", "wrong branch", "dirty", "no repository"]) {
  test(`release rejects ${scenario} without changing files`, () => {
    const dir = mkdtempSync(join(tmpdir(), "copy-picker-release-"));
    try {
      cpSync(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
      for (const name of ["package.json", "package-lock.json"]) cpSync(join(root, name), join(dir, name));
      if (scenario === "no repository") {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        delete manifest.repository;
        writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
      }
      const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      if (scenario !== "no git") {
        git("init", "-b", "main");
        git("add", ".");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
      }
      if (scenario === "wrong version") {
        const lock = JSON.parse(readFileSync(join(dir, "package-lock.json")));
        lock.version = "9.9.9";
        writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
      }
      if (scenario === "wrong branch") git("checkout", "-b", "other");
      if (scenario === "dirty") writeFileSync(join(dir, "dirty"), "dirty");
      const before = readFileSync(join(dir, "package.json"), "utf8");
      const result = spawnSync(process.execPath, ["scripts/release.mjs", "current"], { cwd: dir, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Release aborted:/);
      const expected = { "no git": /git repository/, "wrong version": /lock version mismatch/, "wrong branch": /release requires main/, dirty: /working tree must be clean/, "no repository": /Set repository.url/ }[scenario];
      assert.match(result.stderr, expected);
      assert.equal(readFileSync(join(dir, "package.json"), "utf8"), before);
      if (scenario !== "no git") assert.equal(git("tag", "--list").toString().trim(), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
