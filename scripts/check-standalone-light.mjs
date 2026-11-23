#!/usr/bin/env node
// Verify the Bun-targeted bundle really is a standalone JavaScript file.
// This check intentionally runs outside the repository so that ordinary
// local node_modules cannot mask missing bundled dependencies.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const source = path.join(repoRoot, "dist", "accoding.mjs");
assert.ok(fs.statSync(source).isFile(), "Missing dist/accoding.mjs");
const stat = fs.statSync(source);
assert.ok(stat.size > 0 && stat.size < 20 * 1024 * 1024,
  "Bundle is unexpectedly large (>20 MiB) or empty.");

const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "accoding-thin-"));
try {
  const bundle = path.join(isolated, "accoding.mjs");
  fs.copyFileSync(source, bundle);
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(isolated, "config"),
    APPDATA: path.join(isolated, "config")
  };
  const invoke = (...args) => execFileSync("bun", [bundle, ...args], {
    cwd: isolated, env: environment, encoding: "utf8", timeout: 15_000
  });
  const help = invoke("--help");
  assert.match(help, /Accoding TUI/);
  assert.match(help, /contest init/);
  const paths = invoke("config", "paths");
  assert.match(paths, /state\.json/);
  assert.match(paths, /脚手架/);
  assert.ok(!fs.existsSync(path.join(isolated, "node_modules")));
  console.log(
    "Lightweight Bun single-file check passed:",
    (stat.size / 1024 / 1024).toFixed(2), "MiB"
  );
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}
