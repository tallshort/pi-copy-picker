import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "pi-copy-picker-pack-"));
const expected = ["CHANGELOG.md", "LICENSE", "README.md", "RELEASING.md", "gallery-preview.png", "src/index.ts", "src/history.ts", "src/picker.ts", "package.json"].sort();
try {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(pack.files.map(({ path }) => path).sort(), expected, "unexpected tarball files");
  execFileSync("tar", ["-xzf", join(temporary, pack.filename), "-C", temporary]);
  const p = JSON.parse(readFileSync(join(temporary, "package/package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(p.name, "pi-copy-picker");
  assert.match(p.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  for (const entry of [lock, lock.packages[""]]) {
    assert.equal(entry.name, p.name);
    assert.equal(entry.version, p.version);
  }
  assert.equal(p.private, undefined);
  assert.equal(p.author, "tallshort");
  assert.equal(p.license, "MIT");
  assert.equal(p.publishConfig.access, "public");
  assert.equal(p.main, "./src/index.ts");
  assert.equal(p.exports, p.main);
  assert.deepEqual(p.pi.extensions, [p.main]);
  assert.equal(p.pi.image, "https://raw.githubusercontent.com/tallshort/pi-copy-picker/main/gallery-preview.png");
  const image = readFileSync(join(temporary, "package/gallery-preview.png"));
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 616);
  assert.equal(image.readUInt32BE(20), 385);
  assert(!p.dependencies && !p.bundledDependencies, "the host supplies runtime dependencies");
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(p.peerDependencies[name], ">=1.0.0");
    assert.equal(p.peerDependenciesMeta[name].optional, true);
    assert.equal(p.devDependencies[name], "1.4.0");
  }
  assert.equal(p.scripts.build, undefined);
  assert.equal(p.devDependencies.esbuild, undefined);
  assert.deepEqual(p.files, ["src/", "gallery-preview.png", "README.md", "LICENSE", "CHANGELOG.md", "RELEASING.md"]);
  symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const result = await loadExtensions([join(temporary, "package/src/index.ts")], temporary);
  assert.deepEqual(result.errors, [], "Pi must load the packed TypeScript source");
  assert.equal(result.extensions.length, 1);
  assert.equal(typeof result.extensions[0].commands.get("copy-picker")?.handler, "function");
  assert.equal(typeof result.extensions[0].commands.get("copy-block")?.handler, "function");
  assert.equal(typeof result.extensions[0].shortcuts.get("ctrl+shift+b")?.handler, "function");
  console.log(`Package contract passed: ${pack.filename}\n${expected.join("\n")}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
