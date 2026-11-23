import fs from "node:fs/promises";
import path from "node:path";

export interface ComponentSpec {
  id: string;
  description?: string;
  symbols: string[];
  source: string;
  requires: string[];
}

export interface PresetManifest {
  schemaVersion: 1;
  id: string;
  language: "c";
  standard: "c99";
  headerFile: string;
  systemHeaders: string[];
  components: ComponentSpec[];
}

export interface LoadedPreset {
  manifest: PresetManifest;
  code: Map<string, string>;
  order: string[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*$/;
const HEADER = /^[A-Za-z_][A-Za-z_0-9.-]*\.h$/;
const SYSTEM_HEADER = /^[A-Za-z0-9_./+-]+\.h$/;

function fail(message: string): never {
  throw new Error("Scaffold preset: " + message);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    fail(label + " must be an array of strings");
  return value as string[];
}

export async function loadPreset(manifestPath: string): Promise<LoadedPreset> {
  const requested = await fs.realpath(manifestPath);
  const absolute = (await fs.stat(requested)).isDirectory()
    ? path.join(requested, "manifest.json") : requested;
  const base = path.dirname(absolute);
  const raw: unknown = JSON.parse(await fs.readFile(absolute, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid JSON object");
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== 1) fail("unsupported schemaVersion");
  if (typeof data.id !== "string" || !IDENTIFIER.test(data.id.replace(/-/g, "_")))
    fail("invalid preset id");
  if (data.language !== "c" || data.standard !== "c99")
    fail("only C99 presets are supported in v1");
  if (typeof data.headerFile !== "string" || !HEADER.test(data.headerFile))
    fail("headerFile must be a local .h filename");
  const systemHeaders = stringArray(data.systemHeaders, "systemHeaders");
  if (!systemHeaders.every((name) => SYSTEM_HEADER.test(name) && !name.includes("..")))
    fail("invalid system header");
  if (!Array.isArray(data.components)) fail("components must be an array");

  const components: ComponentSpec[] = [];
  const code = new Map<string, string>();
  const ids = new Set<string>();
  const exported = new Set<string>();
  for (const entry of data.components) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      fail("invalid component");
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !IDENTIFIER.test(id) || ids.has(id))
      fail("invalid or duplicate component id: " + String(id));
    ids.add(id);
    const symbols = stringArray(item.symbols, id + ".symbols");
    const requires = stringArray(item.requires, id + ".requires");
    if (!symbols.length || !symbols.every((name) => IDENTIFIER.test(name)))
      fail("invalid symbols for " + id);
    for (const name of symbols) {
      if (exported.has(name)) fail("duplicate exported symbol: " + name);
      exported.add(name);
    }
    if (!requires.every((name) => IDENTIFIER.test(name)))
      fail("invalid dependencies for " + id);
    if (typeof item.source !== "string" || !item.source.endsWith(".h"))
      fail("source must be a relative .h path for " + id);
    const candidate = path.resolve(base, item.source);
    const relative = path.relative(base, candidate);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative))
      fail("source escapes preset directory: " + item.source);
    const resolved = await fs.realpath(candidate);
    const safe = path.relative(base, resolved);
    if (!safe || safe === ".." || safe.startsWith(".." + path.sep) ||
        path.isAbsolute(safe))
      fail("source resolves outside preset directory: " + item.source);
    const body = await fs.readFile(resolved, "utf8");
    if (/^\s*#\s*include\b/m.test(body))
      fail(id + " must declare systemHeaders in the manifest, not #include");
    code.set(id, body.endsWith("\n") ? body : body + "\n");
    components.push({
      id,
      description: typeof item.description === "string" ? item.description : undefined,
      symbols,
      requires,
      source: item.source
    });
  }

  const byId = new Map(components.map((item) => [item.id, item]));
  const states = new Map<string, number>();
  const order: string[] = [];
  function visit(id: string): void {
    if (!byId.has(id)) fail("unknown dependency: " + id);
    if (states.get(id) === 1) fail("cyclic dependency involving " + id);
    if (states.get(id) === 2) return;
    states.set(id, 1);
    for (const dependency of byId.get(id)!.requires) visit(dependency);
    states.set(id, 2);
    order.push(id);
  }
  for (const item of components) visit(item.id);
  return {
    manifest: {
      schemaVersion: 1,
      id: data.id as string,
      language: "c",
      standard: "c99",
      headerFile: data.headerFile as string,
      systemHeaders,
      components
    },
    code,
    order
  };
}

function includeHeaders(preset: LoadedPreset): string {
  return preset.manifest.systemHeaders.map((name) => "#include <" + name + ">\n").join("");
}

function componentCode(preset: LoadedPreset, selected: Set<string>): string {
  return preset.order.filter((id) => selected.has(id))
    .map((id) => "\n" + preset.code.get(id)!).join("");
}

export function renderHeader(preset: LoadedPreset): string {
  const guard = "ACCODING_" + preset.manifest.headerFile
    .replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return "#ifndef " + guard + "\n#define " + guard + "\n" +
    includeHeaders(preset) +
    componentCode(preset, new Set(preset.order)) +
    "\n#endif\n";
}

/** Replace comments (and optionally literals) with spaces, preserving newlines. */
function maskC(source: string, literals: boolean): string {
  let out = "";
  let state: "code" | "line" | "block" | "single" | "double" = "code";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; out += "  "; i++; continue; }
      if (ch === "/" && next === "*") { state = "block"; out += "  "; i++; continue; }
      if (ch === "'" || ch === '"') {
        state = ch === "'" ? "single" : "double";
        out += literals ? " " : ch;
        continue;
      }
      out += ch;
      continue;
    }
    if (state === "line") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\n") state = "code";
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        out += "  "; i++; state = "code";
      } else out += ch === "\n" ? "\n" : " ";
    } else if (ch === "\\") {
      out += literals ? " " : ch;
      if (next !== undefined) {
        out += literals && next !== "\n" ? " " : next;
        i++;
      }
    } else if (ch === (state === "single" ? "'" : '"')) {
      out += literals ? " " : ch;
      state = "code";
    } else out += literals && ch !== "\n" ? " " : ch;
  }
  return out;
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Assemble only explicitly used exported symbols and their component dependencies. */
export function assembleC(source: string, preset: LoadedPreset): {
  code: string;
  components: string[];
} {
  const withoutComments = lines(maskC(source, false));
  const sourceLines = lines(source);
  if (sourceLines.length !== withoutComments.length)
    fail("cannot inspect source line boundaries");
  let includeAt = -1;
  let conditionDepth = 0;
  for (let i = 0; i < sourceLines.length; i++) {
    const line = withoutComments[i].trim();
    if (/^#\s*(if|ifdef|ifndef)\b/.test(line)) conditionDepth++;
    if (/^#\s*endif\b/.test(line)) conditionDepth--;
    if (conditionDepth < 0) fail("unbalanced preprocessor condition");
    if (!/^#\s*include\b/.test(line)) continue;
    const directive = /^#\s*include\s*(?:<([^>\n]+)>|"([^"\n]+)")\s*$/.exec(line);
    if (!directive) fail("unsupported #include directive at line " + (i + 1));
    if (directive[1]) continue; // Standard/system include remains in main.c.
    if (directive[2] !== preset.manifest.headerFile)
      fail("other local headers are unsupported in C99 single-file mode: " + directive[2]);
    if (conditionDepth !== 0) fail("exam header must be included unconditionally");
    if (includeAt !== -1) fail("exam header must be included exactly once");
    includeAt = i;
  }
  if (includeAt === -1) fail('missing #include "' + preset.manifest.headerFile + '"');
  const symbols = new Set(maskC(source, true).match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []);
  const selected = new Set<string>();
  const byId = new Map(preset.manifest.components.map((component) => [component.id, component]));
  function select(id: string): void {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dependency of byId.get(id)!.requires) select(dependency);
  }
  for (const component of preset.manifest.components) {
    if (component.symbols.some((name) => symbols.has(name))) select(component.id);
  }
  const definitions = includeHeaders(preset) + componentCode(preset, selected);
  const result = sourceLines.slice();
  result[includeAt] = definitions + "\n#line " + (includeAt + 2) + ' "main.c"\n';
  return { code: result.join(""), components: preset.order.filter((id) => selected.has(id)) };
}

export async function initializeHeader(folder: string, preset: LoadedPreset): Promise<string> {
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, preset.manifest.headerFile);
  await fs.writeFile(target, renderHeader(preset), { encoding: "utf8", flag: "wx" });
  return target;
}
