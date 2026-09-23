import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

const expectedDiffFiles = [
  "extension/node_modules/diff/LICENSE",
  "extension/node_modules/diff/lib/convert/dmp.js",
  "extension/node_modules/diff/lib/convert/xml.js",
  "extension/node_modules/diff/lib/diff/array.js",
  "extension/node_modules/diff/lib/diff/base.js",
  "extension/node_modules/diff/lib/diff/character.js",
  "extension/node_modules/diff/lib/diff/css.js",
  "extension/node_modules/diff/lib/diff/json.js",
  "extension/node_modules/diff/lib/diff/line.js",
  "extension/node_modules/diff/lib/diff/sentence.js",
  "extension/node_modules/diff/lib/diff/word.js",
  "extension/node_modules/diff/lib/index.es6.js",
  "extension/node_modules/diff/lib/index.js",
  "extension/node_modules/diff/lib/index.mjs",
  "extension/node_modules/diff/lib/patch/apply.js",
  "extension/node_modules/diff/lib/patch/create.js",
  "extension/node_modules/diff/lib/patch/merge.js",
  "extension/node_modules/diff/lib/patch/parse.js",
  "extension/node_modules/diff/lib/patch/reverse.js",
  "extension/node_modules/diff/lib/util/array.js",
  "extension/node_modules/diff/lib/util/distance-iterator.js",
  "extension/node_modules/diff/lib/util/params.js",
  "extension/node_modules/diff/package.json"
].sort();

function main(): void {
  const argument = process.argv[2];
  assert.ok(argument, "Usage: npm run verify:vsix -- <path-to-vsix>");
  const vsixPath = path.resolve(argument);
  assert.ok(existsSync(vsixPath), `VSIX does not exist: ${vsixPath}`);

  const entries = execFileSync("unzip", ["-Z1", vsixPath], {
    encoding: "utf8"
  })
    .split(/\r?\n/u)
    .filter(Boolean);
  assert.ok(
    entries.includes("extension/install.md"),
    "VSIX must include the lowercase install.md guide"
  );
  const diffFiles = entries
    .filter((entry) => entry.startsWith("extension/node_modules/diff/"))
    .sort();
  assert.deepEqual(
    diffFiles,
    expectedDiffFiles,
    "VSIX must contain exactly the required diff 5.2.2 runtime files"
  );

  const otherRuntimeDependencies = entries.filter(
    (entry) =>
      entry.startsWith("extension/node_modules/") &&
      !entry.startsWith("extension/node_modules/diff/")
  );
  assert.deepEqual(
    otherRuntimeDependencies,
    [],
    "VSIX contains unexpected production dependencies"
  );
  const packagedDiffManifest = JSON.parse(
    execFileSync("unzip", [
      "-p",
      vsixPath,
      "extension/node_modules/diff/package.json"
    ], { encoding: "utf8" })
  ) as { version?: unknown; main?: unknown };
  assert.equal(packagedDiffManifest.version, "5.2.2");
  assert.equal(packagedDiffManifest.main, "./lib/index.js");
  console.log(
    `Verified ${diffFiles.length} diff runtime files in ${path.basename(vsixPath)}`
  );
}

main();
