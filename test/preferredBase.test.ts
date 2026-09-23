import assert from "node:assert/strict";
import test from "node:test";
import { selectPreferredBase } from "../src/preferredBase";

void test("prefers the most recently selected branch when it still exists", () => {
  assert.equal(
    selectPreferredBase(["develop", "main", "release"], "release"),
    "release"
  );
});

void test("falls back through main, master, and develop", () => {
  assert.equal(selectPreferredBase(["develop", "master", "main"], "gone"), "main");
  assert.equal(selectPreferredBase(["develop", "master"], undefined), "master");
  assert.equal(selectPreferredBase(["develop"], undefined), "develop");
});

void test("uses the first branch alphabetically as the final fallback", () => {
  assert.equal(
    selectPreferredBase(["z-feature", "a-feature", "m-feature"], undefined),
    "a-feature"
  );
});

void test("returns undefined when there are no alternatives", () => {
  assert.equal(selectPreferredBase([], "main"), undefined);
});
