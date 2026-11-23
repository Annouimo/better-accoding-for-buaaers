import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleC, initializeHeader, loadPreset, renderHeader } from "../../src/standalone/scaffold.ts";

const manifest = fileURLToPath(new URL("../../scaffold/presets/example-c99/manifest.json", import.meta.url));

test("example preset loads and generates a complete include-compatible header", async () => {
  const preset = await loadPreset(manifest);
  assert.deepEqual(preset.order, ["gcd_u64", "lcm_u64"]);
  const header = renderHeader(preset);
  assert.match(header, /#ifndef ACCODING_EXAM_H/);
  assert.match(header, /static unsigned long long exam_gcd_u64/);
  assert.match(header, /static unsigned long long exam_lcm_u64/);
  assert.ok(header.indexOf("exam_gcd_u64") < header.indexOf("exam_lcm_u64"));
});

test("only referenced API and transitive dependencies are expanded", async () => {
  const preset = await loadPreset(manifest);
  const gcdSource = [
    '#include <stdio.h>',
    '#include "exam.h"',
    'int main(void) {',
    '  const char *text = "exam_lcm_u64";',
    '  // exam_lcm_u64 must not activate a component',
    '  printf("%llu\n", exam_gcd_u64(18, 12));',
    '  return text[0] == 0;',
    '}'
  ].join("\n");
  const gcd = assembleC(gcdSource, preset);
  assert.deepEqual(gcd.components, ["gcd_u64"]);
  assert.doesNotMatch(gcd.code, /static unsigned long long exam_lcm_u64/);
  assert.doesNotMatch(gcd.code, /#include "exam.h"/);
  assert.match(gcd.code, /#include <stdio.h>/);
  const lcm = assembleC(
    '#include "exam.h"\nunsigned long long f(void) { return exam_lcm_u64(12, 18); }\n',
    preset
  );
  assert.deepEqual(lcm.components, ["gcd_u64", "lcm_u64"]);
});

test("unsupported local includes and conditional exam includes fail", async () => {
  const preset = await loadPreset(manifest);
  assert.throws(
    () => assembleC('#include "other.h"\n#include "exam.h"\n', preset),
    /other local headers/
  );
  assert.throws(
    () => assembleC('#if 1\n#include "exam.h"\n#endif\n', preset),
    /unconditionally/
  );
  assert.throws(
    () => assembleC('int main(void) { return 0; }\n', preset),
    /missing #include/
  );
});

test("dependency errors and unsafe source paths are rejected", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-test-"));
  try {
    const original = JSON.parse(await fs.readFile(manifest, "utf8"));
    const source = path.join(temp, "component.h");
    await fs.writeFile(source, "static int demo(void) { return 1; }\n");
    original.components = [{
      id: "demo", symbols: ["demo"], source: "component.h", requires: ["missing"]
    }];
    const file = path.join(temp, "manifest.json");
    await fs.writeFile(file, JSON.stringify(original));
    await assert.rejects(loadPreset(file), /unknown dependency/);
    original.components[0].requires = [];
    original.components[0].source = "../outside.h";
    await fs.writeFile(file, JSON.stringify(original));
    await assert.rejects(loadPreset(file), /escapes preset directory/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("header initialization never overwrites existing file", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-init-"));
  try {
    const preset = await loadPreset(manifest);
    await initializeHeader(temp, preset);
    await assert.rejects(initializeHeader(temp, preset), { code: "EEXIST" });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
