import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ProblemActivity {
  verdict?: string;
  lastActiveAt?: string;
  sourceFile?: string;
}
export interface ApplicationState {
  schemaVersion: 1;
  lastWorkspace?: string;
  lastProblem?: string;
  lastAccount?: string;
  presetPath?: string;
  problems: Record<string, ProblemActivity>;
}

export function configDirectory(): string {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "accoding-tui")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "accoding-tui");
}
export const emptyState = (): ApplicationState => ({ schemaVersion: 1, problems: {} });

function activityKey(root: string, bindingId: string, account: string): string {
  return JSON.stringify([path.resolve(root), bindingId, account]);
}

export class StateStore {
  constructor(readonly file = path.join(configDirectory(), "state.json")) {}

  async load(): Promise<ApplicationState> {
    let content: string;
    try {
      content = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid application state; original file was preserved.");
    const record = data as Record<string, unknown>;
    if (record.schemaVersion !== 1 ||
        !record.problems || typeof record.problems !== "object" ||
        Array.isArray(record.problems))
      throw new Error("Unsupported application state; original file was preserved.");
    return data as ApplicationState;
  }

  async save(state: ApplicationState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + "." + process.pid + ".tmp";
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  async rememberPreset(file?: string): Promise<void> {
    const state = await this.load();
    if (file) state.presetPath = path.resolve(file);
    else delete state.presetPath;
    await this.save(state);
  }

  async rememberWorkspace(root: string): Promise<void> {
    const state = await this.load();
    state.lastWorkspace = path.resolve(root);
    await this.save(state);
  }

  async rememberProblem(
    root: string, bindingId: string, account: string,
    changes: Partial<ProblemActivity> = {}
  ): Promise<void> {
    const state = await this.load();
    const key = activityKey(root, bindingId, account);
    state.problems[key] = {
      ...state.problems[key], ...changes, lastActiveAt: new Date().toISOString()
    };
    state.lastWorkspace = path.resolve(root);
    state.lastProblem = key;
    state.lastAccount = account;
    await this.save(state);
  }

  getActivity(
    state: ApplicationState, root: string, bindingId: string, account: string
  ): ProblemActivity {
    return state.problems[activityKey(root, bindingId, account)] ?? {};
  }

  isLastProblem(
    state: ApplicationState, root: string, bindingId: string, account: string
  ): boolean {
    return state.lastProblem === activityKey(root, bindingId, account);
  }
}

export function isAccepted(verdict?: string): boolean {
  return verdict?.trim().toUpperCase() === "AC";
}
