import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Problem } from "../model";
import { ask, interactive } from "./terminal";

export function droppedPath(raw: string, cwd = process.cwd(), home = os.homedir()): string {
  let text = raw.trim();
  // macOS Finder/Terminal can paste quoted paths or shell-escaped spaces.
  if ((text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"')))
    text = text.slice(1, -1);
  else if (process.platform !== "win32")
    text = text.replace(/\\([ \\()'"\[\]{}!#&;$])/g, "$1");
  if (text === "~") text = home;
  else if (text.startsWith("~/") || text.startsWith("~\\"))
    text = path.join(home, text.slice(2));
  if (!text || /[\r\n\0]/.test(text)) throw new Error("请输入单个有效的目录路径。");
  return path.resolve(cwd, text);
}

export function readableName(raw: string, fallback = "未命名"): string {
  let text = raw.normalize("NFC")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "").trim().slice(0, 65).trim();
  // Names must be valid for Windows even if generated on macOS.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text))
    text = "_" + text;
  return text || fallback;
}

export function preferredRoot(title: string): string {
  return path.join(os.homedir(), "Accoding", readableName(title));
}

export async function selectWorkspaceDirectory(title: string, explicit?: string): Promise<string> {
  if (explicit) return droppedPath(explicit);
  const suggested = preferredRoot(title);
  if (!interactive()) return suggested;
  console.log("\n保存目录：可以把 Finder 或文件资源管理器中的文件夹拖进终端，再按回车。");
  console.log("每场比赛只需选择一次，已存在的源文件不会被覆盖。");
  const entered = await ask("保存到", suggested);
  return droppedPath(entered);
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export async function isFriendlyWorkspace(root: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(root,
      ".better-accoding", "friendly-layout.json"), "utf8")) as { version?: number };
    return marker.version === 1;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Legacy workspaces keep the numeric layout; only fresh standalone ones get readable names. */
export async function initializeFriendlyLayout(root: string): Promise<boolean> {
  if (await isFriendlyWorkspace(root)) return true;
  if (await exists(path.join(root, ".better-accoding", "workspace.json")) ||
      await exists(path.join(root, "contests")) ||
      await exists(path.join(root, "problems")))
    return false;
  const folder = path.join(root, ".better-accoding");
  await fs.mkdir(folder, { recursive: true });
  try {
    await fs.writeFile(path.join(folder, "friendly-layout.json"),
      JSON.stringify({ version: 1, kind: "standalone" }, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return true;
}

export async function readableProblemDirectory(
  root: string, problem: Problem
): Promise<string> {
  const label = problem.target.kind === "contest"
    ? readableName(problem.label, "题")
    : "题目";
  const candidate = readableName(label + "-" + problem.title);
  if (!(await exists(path.join(root, candidate)))) return candidate;
  // Avoid accidentally taking ownership of an unrelated user's directory.
  const suffix = problem.target.problemId;
  const withId = readableName(candidate.slice(0, 54)) + "-" + suffix;
  if (!(await exists(path.join(root, withId)))) return withId;
  for (let i = 2; i < 1000; i++) {
    const name = withId + "-" + i;
    if (!(await exists(path.join(root, name)))) return name;
  }
  throw new Error("无法为题目分配不冲突的文件夹名称。");
}
