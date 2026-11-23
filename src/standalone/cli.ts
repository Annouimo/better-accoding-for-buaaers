#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assembleC,
  initializeHeader,
  loadPreset,
  type LoadedPreset
} from "./scaffold";

const exec = promisify(execFile);
const SAMPLE_PRESET = path.resolve("scaffold/presets/example-c99/manifest.json");

function usage(): void {
  console.log([
    "Accoding standalone CLI (early scaffold prototype)",
    "",
    "  bun src/standalone/cli.ts scaffold init DIR [--preset MANIFEST]",
    "  bun src/standalone/cli.ts scaffold prepare SOURCE [--preset MANIFEST] [--cc COMPILER]",
    "",
    "init:    Generate exam.h, main.c and a per-problem preset snapshot.",
    "prepare: Expand used C99 components, save .accoding/submit.c, and compile-check.",
    "This prototype does not connect to Accoding or submit code yet."
  ].join("\n"));
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error("Missing value for " + name);
  return args[index + 1];
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Keep the code-generation library unchanged for an existing solution. */
async function snapshotPreset(
  folder: string,
  preset: LoadedPreset
): Promise<void> {
  const base = path.join(folder, ".accoding", "scaffold");
  await fs.mkdir(base, { recursive: true });
  const manifest = path.join(base, "manifest.json");
  await fs.writeFile(manifest, JSON.stringify(preset.manifest, null, 2) + "\n", {
    encoding: "utf8", flag: "wx"
  });
  for (const component of preset.manifest.components) {
    const target = path.resolve(base, component.source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, preset.code.get(component.id)!, {
      encoding: "utf8", flag: "wx"
    });
  }
}

async function init(folderArg: string, manifestArg?: string): Promise<void> {
  const folder = path.resolve(folderArg);
  const preset = await loadPreset(path.resolve(manifestArg ?? SAMPLE_PRESET));
  const header = path.join(folder, preset.manifest.headerFile);
  const main = path.join(folder, "main.c");
  const snapshot = path.join(folder, ".accoding", "scaffold", "manifest.json");
  for (const file of [header, main, snapshot]) {
    if (await exists(file)) throw new Error("Refusing to overwrite existing file: " + file);
  }
  await fs.mkdir(folder, { recursive: true });
  await snapshotPreset(folder, preset);
  await initializeHeader(folder, preset);
  await fs.writeFile(main,
    '#include "' + preset.manifest.headerFile +
    '"\n\nint main(void) {\n    return 0;\n}\n',
    { encoding: "utf8", flag: "wx" });
  console.log("Initialized: " + folder);
  console.log("Generated: " + path.basename(main) + ", " + path.basename(header));
  console.log("Preset snapshot: .accoding/scaffold/manifest.json");
}

async function checkC(source: string, folder: string, compiler: string): Promise<void> {
  const storage = path.join(folder, ".accoding");
  await fs.mkdir(storage, { recursive: true });
  const temp = await fs.mkdtemp(path.join(storage, "check-"));
  try {
    const output = path.join(temp, process.platform === "win32" ? "program.exe" : "program");
    const args = ["-std=c99", "-O2", "-Wall", "-Wextra", "-Wno-unused-function",
      source, "-o", output, "-lm"];
    try {
      await exec(compiler, args, { cwd: folder, windowsHide: true, timeout: 15000 });
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new Error("Compile check failed (" + compiler + "):\n" +
        (failure.stderr || failure.message));
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function prepare(sourceArg: string, manifestArg?: string, compiler?: string): Promise<void> {
  const source = path.resolve(sourceArg);
  if (path.extname(source).toLowerCase() !== ".c")
    throw new Error("C99 scaffold assembly only accepts .c files; C++ support is separate.");
  const folder = path.dirname(source);
  const presetPath = manifestArg
    ? path.resolve(manifestArg)
    : path.join(folder, ".accoding", "scaffold", "manifest.json");
  const preset = await loadPreset(presetPath);
  const result = assembleC(await fs.readFile(source, "utf8"), preset);
  const output = path.join(folder, ".accoding", "submit.c");
  if (path.resolve(output) === source) throw new Error("Cannot overwrite source");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, result.code, "utf8");
  await checkC(output, folder, compiler || process.env.CC || "cc");
  console.log("Compile check passed: " + output);
  console.log("Included components: " +
    (result.components.length ? result.components.join(", ") : "(none)"));
  console.log("Submission bytes: " + Buffer.byteLength(result.code, "utf8"));
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    usage();
    return;
  }
  if (argv[0] !== "scaffold") throw new Error("Unknown command. Use --help.");
  if (argv[1] === "init" && argv[2]) {
    await init(argv[2], option(argv.slice(3), "--preset"));
    return;
  }
  if (argv[1] === "prepare" && argv[2]) {
    await prepare(argv[2],
      option(argv.slice(3), "--preset"),
      option(argv.slice(3), "--cc"));
    return;
  }
  throw new Error("Invalid scaffold command. Use --help.");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error("Error: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
