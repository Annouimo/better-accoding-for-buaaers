import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountSession } from "../auth/session";
import { login, currentUser, ContestAdapter, ProblemsetAdapter } from "../accoding/adapters";
import { fetchContestSnapshotForImport } from "../accoding/import";
import { syncContest } from "../workspace/contest";
import { WorkspaceStore } from "../workspace/store";
import { defaultSourceFiles, cTemplate, cppTemplate } from "../workspace/sources";
import { compile, judge, type Toolchain } from "../judge/judge";
import { sendSubmission } from "../submissions/send";
import { SubmissionStore, isPending } from "../submissions/store";
import { monitorSubmissions } from "../submissions/monitor";
import { bindingId, hash, parseImport, type Binding, type Problem, type Target } from "../model";
import { assembleC, initializeHeader, loadPreset, type LoadedPreset } from "./scaffold";
import { builtinPreset } from "./generated-preset";
import { StateStore, isAccepted, activityAccepted } from "./state";
import { credentialsBackend } from "./secrets";
import { ask, confirm, interactive, select, password } from "./terminal";
import { selectWorkspaceDirectory, initializeFriendlyLayout, isFriendlyWorkspace, readableProblemDirectory, droppedPath } from "./workspaces";

export interface ResolvedProblem {
  root: string;
  workspace: WorkspaceStore;
  binding: Binding;
  source: string;
}

export function toolchain(config: { c?: string; cpp?: string } = {}): Toolchain {
  return {
    c: process.env.ACCODING_CC || process.env.CC || config.c ||
      (process.platform === "win32" ? "gcc" : "cc"),
    cpp: process.env.ACCODING_CXX || process.env.CXX || config.cpp ||
      (process.platform === "win32" ? "g++" : "c++"),
    cArgs: ["-std=c99", "-O2", "-Wall", "-Wextra", "-Wno-unused-function"],
    cppArgs: ["-std=c++17", "-O2", "-Wall", "-Wextra"],
    cLinkArgs: ["-lm"],
    timeoutMs: 2000,
    outputLimit: 4 * 1024 * 1024
  };
}

function localPath(root: string, relative: string): string {
  const result = path.resolve(root, relative);
  const fromRoot = path.relative(root, result);
  if (fromRoot === ".." || fromRoot.startsWith(".." + path.sep) ||
      path.isAbsolute(fromRoot))
    throw new Error("Source path is outside the workspace.");
  return result;
}

async function fileExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function savePresetSnapshot(directory: string, preset: LoadedPreset): Promise<void> {
  const location = path.join(directory, ".accoding", "scaffold");
  const manifest = path.join(location, "manifest.json");
  if (await fileExists(manifest)) return;
  await fs.mkdir(location, { recursive: true });
  for (const component of preset.manifest.components) {
    const target = path.resolve(location, component.source);
    const inside = path.relative(location, target);
    if (!inside || inside.startsWith(".." + path.sep) || path.isAbsolute(inside))
      throw new Error("Invalid component source location.");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, preset.code.get(component.id)!, { flag: "wx" });
  }
  await fs.writeFile(manifest, JSON.stringify(preset.manifest, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" });
}

function sourceFor(binding: Binding, root: string): string {
  return localPath(root, binding.sourceFile);
}

export function submissionLanguageChoices(problem: Problem, source: string): string[] {
  const isC = path.extname(source).toLowerCase() === ".c";
  return problem.languages.filter((value) => {
    const normalized = value.toLowerCase().replace(/\s+/g, "");
    const cpp = /cpp|c\+\+|g\+\+|clang\+\+|^gnu\+\+/.test(normalized);
    if (!isC) return cpp;
    return !cpp && (/^c(?:\d|$)|gcc|clang|gnu99|gnu11|gnu17/.test(normalized));
  });
}

export class StandaloneWorkflow {
  readonly state = new StateStore();
  readonly credentialBackend = credentialsBackend();
  readonly session = new AccountSession(this.credentialBackend.store);
  private restored = false;
  private tested = new Map<string, { code: string; stamp: string }>();

  async account(required = true): Promise<string | undefined> {
    if (!this.restored) {
      this.restored = true;
      try {
        await this.session.restore();
      } catch (error) {
        this.restored = false;
        if (required) throw error;
      }
    }
    if (required) {
      const user = await this.session.ensure();
      if (!user) throw new Error("尚未登录 Accoding。请先运行 accoding login。");
      return user.id;
    }
    return this.session.user?.id;
  }

  async login(): Promise<void> {
    if (!interactive()) throw new Error("登录需要交互式终端，以免在命令行参数中泄露密码。");
    const username = await ask("Accoding 账号");
    if (!username) throw new Error("账号不能为空。");
    const pass = await password("Accoding 密码");
    if (!pass) throw new Error("密码不能为空。");
    const remember = this.credentialBackend.persistent
      ? await confirm("保持登录并将凭据保存在系统安全存储中？选择“否”仅本次运行有效", true)
      : false;
    await this.credentialBackend.setSessionOnly(!remember);
    const user = await this.session.signIn({ username, password: pass }, remember);
    this.restored = true;
    const state = await this.state.load();
    state.lastAccount = user.id;
    await this.state.save(state);
    console.log("已登录 Accoding。账号 ID：" + user.id);
    if (!this.credentialBackend.persistent)
      console.log("当前平台仅支持会话内凭据，不会保存密码。");
  }

  async logout(): Promise<void> {
    await this.session.logout();
    this.restored = true;
    console.log("已退出登录并清除已保存的会话凭据。");
  }

  async workspaceRoot(explicit?: string): Promise<string> {
    const saved = await this.state.load();
    const root = droppedPath(explicit || saved.lastWorkspace ||
      path.join(os.homedir(), "Accoding"));
    await fs.mkdir(root, { recursive: true });
    await this.state.rememberWorkspace(root);
    return root;
  }

  private async ensureScaffold(root: string, binding: Binding, preset: LoadedPreset): Promise<void> {
    const fallback = defaultSourceFiles(binding.problem.target);
    const sourceDir = binding.problemDirectory ?? path.posix.dirname(fallback.c);
    const source = localPath(root, path.posix.join(sourceDir, "main.c"));
    const directory = path.dirname(source);
    const existingPreset = path.join(directory, ".accoding", "scaffold", "manifest.json");
    const chosen = (await fileExists(existingPreset))
      ? await loadPreset(existingPreset) : preset;
    await savePresetSnapshot(directory, chosen);
    try {
      await initializeHeader(directory, chosen);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Only touch a newly imported, untouched default program.
    const existing = await fs.readFile(source, "utf8");
    if (existing === cTemplate)
      await fs.writeFile(source, '#include "' + chosen.manifest.headerFile + '"\n' + existing,
        "utf8");
    // Do not bring the original VS Code extension\'s large competitive template
    // into the minimal standalone C++ workflow.
    const cpp = localPath(root, path.posix.join(sourceDir, "main.cpp"));
    if (await fs.readFile(cpp, "utf8") === cppTemplate)
      await fs.writeFile(cpp,
        "#include <iostream>\n\nint main() {\n    return 0;\n}\n", "utf8");
  }

  async configuredToolchain(): Promise<Toolchain> {
    const state = await this.state.load();
    return toolchain({ c: state.compilerC, cpp: state.compilerCpp });
  }

  async setCompiler(language: "c" | "cpp", executable: string): Promise<void> {
    await this.state.rememberCompiler(language, executable.trim());
    console.log((language === "c" ? "C" : "C++") +
      " 编译器：" + (executable.trim() || "自动检测"));
  }

  async activePreset(explicit?: string): Promise<LoadedPreset> {
    const file = explicit || (await this.state.load()).presetPath;
    return file ? loadPreset(file) : builtinPreset();
  }

  async setPreset(file?: string): Promise<void> {
    if (file) {
      const preset = await loadPreset(file);
      console.log("脚手架配置：" + preset.manifest.id +
        "，共 " + preset.manifest.components.length + " 个组件。");
    }
    await this.state.rememberPreset(file);
  }

  async importContest(value: string, rootArg?: string, presetPath?: string): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    const input = parseImport(value, "contest");
    if (input.kind !== "contest") throw new Error("请提供比赛 ID 或比赛链接。");
    const snapshot = await fetchContestSnapshotForImport(this.session.client, input.id,
      (line) => console.log(line));
    const picked = await selectWorkspaceDirectory(snapshot.title, rootArg);
    const root = await this.workspaceRoot(picked);
    const friendly = await initializeFriendlyLayout(root);
    const workspace = new WorkspaceStore(root);
    const preset = await this.activePreset(presetPath);
    const imported = await syncContest(workspace, snapshot, undefined, undefined,
      friendly ? (problem) => readableProblemDirectory(root, problem) : undefined);
    for (const binding of imported) await this.ensureScaffold(root, binding, preset);
    if (imported.length) {
      const recent = imported.find((b) => !b.unavailable);
      if (recent) await this.state.rememberProblem(root, recent.bindingId, account);
    }
    console.log("比赛：" + snapshot.title + "（" + snapshot.id + "）");
    console.log("当前可访问：" + snapshot.problems.length + " 题；本地已处理：" +
      imported.length + " 题。");
    await this.refreshContestVerdicts(root, snapshot.id, account, snapshot.problems);
  }

  private async refreshContestVerdicts(
    root: string, contestId: string, account: string, problems: Problem[]
  ): Promise<void> {
    // Best-effort status refresh. Import still works if the submission list
    // endpoint is temporarily inaccessible.
    try {
      const result: unknown = await this.session.client.json(
        "/api/contests/" + contestId + "/submissions"
      );
      if (!Array.isArray(result)) return;
      const targets = new Map(problems.map((p) => [p.target.problemId, p.target]));
      const latest = new Map<string, string>();
      for (const row of result) {
        if (!row || typeof row !== "object") continue;
        const s = row as Record<string, unknown>;
        if (String(s.creator_id ?? "") !== account) continue;
        const problemId = String(s.problem_id ?? "");
        const verdict = typeof s.result === "string" ? s.result : "";
        if (!targets.has(problemId) || !verdict) continue;
        if (!isAccepted(latest.get(problemId)) || isAccepted(verdict))
          latest.set(problemId, verdict);
      }
      for (const [id, verdict] of latest) {
        const target = targets.get(id)!;
        await this.state.recordVerdict(root, bindingId(target), account, verdict);
      }
    } catch (error) {
      console.warn("未能同步旧提交状态，稍后可以手动更新：" +
        (error instanceof Error ? error.message : String(error)));
    }
  }

  async importProblem(value: string, rootArg?: string, presetPath?: string): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    const input = parseImport(value, "problemset");
    if (input.kind !== "problemset") throw new Error("请提供独立题号或题目链接。");
    let problem: Problem;
    try {
      problem = await new ProblemsetAdapter(this.session.client).fetch(input.id);
    } catch (error) {
      // Only explicit access denial can fall back to the admin reader.
      if (!(error instanceof Error) || !/权限|访问|forbidden/i.test(error.message))
        throw error;
      problem = await new ProblemsetAdapter(this.session.client.adminReader()).fetch(input.id);
    }
    const picked = await selectWorkspaceDirectory(problem.title, rootArg);
    const root = await this.workspaceRoot(picked);
    const friendly = await initializeFriendlyLayout(root);
    const workspace = new WorkspaceStore(root);
    const binding = await workspace.import(problem,
      friendly ? await readableProblemDirectory(root, problem) : undefined);
    await this.ensureScaffold(root, binding, await this.activePreset(presetPath));
    await this.state.rememberProblem(root, binding.bindingId, account);
    console.log("已导入：" + binding.problem.title);
    console.log("目录：" + path.dirname(sourceFor(binding, root)));
  }

  async sync(rootArg?: string): Promise<void> {
    await this.account();
    const root = await this.workspaceRoot(rootArg);
    const workspace = new WorkspaceStore(root);
    const all = await workspace.list();
    const contestIds = [...new Set(all.flatMap((b) =>
      b.problem.target.kind === "contest" ? [b.problem.target.contestId] : []))];
    for (const id of contestIds) {
      const snapshot = await fetchContestSnapshotForImport(this.session.client, id);
      const friendly = await isFriendlyWorkspace(root);
      const bindings = await syncContest(workspace, snapshot, undefined, undefined,
        friendly ? (problem) => readableProblemDirectory(root, problem) : undefined);
      for (const binding of bindings) {
        if (!binding.unavailable)
          await this.ensureScaffold(root, binding, await this.activePreset());
      }
      console.log("比赛 " + id + " 已同步。");
    }
    for (const binding of all) {
      if (binding.problem.target.kind !== "problemset") continue;
      const problem = await new ProblemsetAdapter(
        binding.problem.target.service === "admin"
          ? this.session.client.adminReader()
          : this.session.client
      ).fetch(binding.problem.target.problemId);
      await workspace.sync(binding, problem);
      console.log("题号 " + binding.problem.target.problemId + " 已同步。");
    }
  }

  async resolve(sourceArg: string): Promise<ResolvedProblem> {
    const source = path.resolve(sourceArg);
    const extension = path.extname(source).toLowerCase();
    if (![".c", ".cpp", ".cc", ".cxx"].includes(extension))
      throw new Error("只支持 C/C++ 源文件。");
    if (!(await fileExists(source))) throw new Error("找不到源文件：" + source);
    let directory = path.dirname(source);
    while (true) {
      const index = path.join(directory, ".better-accoding", "bindings");
      if (await fileExists(index)) {
        const workspace = new WorkspaceStore(directory);
        const bindings = await workspace.list();
        const binding = bindings.find((item) => {
          const known = defaultSourceFiles(item.problem.target);
          const folder = item.problemDirectory ?? path.posix.dirname(known.c);
          const sourceDirectory = localPath(directory, folder);
          if (path.dirname(source) !== sourceDirectory) return false;
          // Only managed entrypoints, or an explicitly bound custom source, can be submitted.
          return ["main.c", "main.cpp"].includes(path.basename(source)) ||
            path.resolve(directory, item.sourceFile) === source;
        });
        if (!binding) throw new Error("当前文件不属于已初始化的题目。");
        if (binding.unavailable) throw new Error("题目已从比赛移除，暂不能提交。");
        return { root: directory, workspace, binding, source };
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error("找不到 Accoding 工作区。请先通过 TUI 初始化比赛或单题。");
  }

  async prepare(resolved: ResolvedProblem): Promise<{ source: string; code: string }> {
    const original = await fs.readFile(resolved.source, "utf8");
    const ext = path.extname(resolved.source).toLowerCase();
    if (ext !== ".c") {
      if (/^\s*#\s*include\s*"/m.test(original))
        throw new Error("C++ 第一版不支持自动展开自定义头文件，请先合并为单文件。");
      return { source: resolved.source, code: original };
    }
    const presetFile = path.join(path.dirname(resolved.source),
      ".accoding", "scaffold", "manifest.json");
    if (!(await fileExists(presetFile))) {
      if (/^\s*#\s*include\s*"/m.test(original))
        throw new Error("使用了本地头文件，但未找到可展开的脚手架配置快照。");
      return { source: resolved.source, code: original };
    }
    const preset = await loadPreset(presetFile);
    const hasInclude = original.split(/\r?\n/).some((line) =>
      new RegExp('^\\s*#\\s*include\\s*"' + preset.manifest.headerFile.replace(/\./g, "\\.") + '"').test(line));
    if (!hasInclude) {
      if (/^\s*#\s*include\s*"/m.test(original))
        throw new Error("检测到其他本地头文件；C99 单文件模式只支持配置中的头文件。");
      return { source: resolved.source, code: original };
    }
    const assembled = assembleC(original, preset);
    const location = path.join(path.dirname(resolved.source), ".accoding", "submit.c");
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(location, assembled.code, "utf8");
    return { source: location, code: assembled.code };
  }

  async test(resolved: ResolvedProblem): Promise<boolean> {
    const account = (await this.state.load()).lastAccount || "offline";
    const prepared = await this.prepare(resolved);
    await this.state.rememberProblem(resolved.root, resolved.binding.bindingId,
      account, { sourceFile: resolved.source });
    const cases = resolved.binding.cases;
    if (!cases.length) {
      console.log("未找到官方样例，不能自动判定正确。");
      return false;
    }
    const storage = path.join(resolved.root, ".accoding", "runs");
    this.tested.delete(resolved.source);
    const result = await judge(prepared.source, storage, cases,
      await this.configuredToolchain(), undefined, path.dirname(resolved.source));
    try {
      if (result.compilation.exitCode !== 0 || result.compilation.reason) {
        console.error("编译失败：\n" + result.compilation.stderr);
        return false;
      }
      for (let i = 0; i < result.cases.length; i++) {
        const entry = result.cases[i];
        const original = cases.find((c) => c.id === entry.id);
        console.log((i + 1) + ". " + (original?.name || "样例") + " : " + entry.status);
        if (entry.status === "FAIL") {
          console.log("  预期：" + (entry.diff?.expected ?? "(无)"));
          console.log("  实际：" + (entry.diff?.actual ?? "(无)"));
        } else if (entry.stderr) {
          console.log("  stderr：" + entry.stderr.slice(0, 500));
        }
      }
      const allPass = result.cases.length > 0 &&
        result.cases.length === cases.filter((c) => c.enabled).length &&
        result.cases.every((c) => c.status === "PASS");
      console.log(allPass ? "全部本地样例通过。" : "有用例未通过。");
      if (allPass) this.tested.set(resolved.source, {
        code: prepared.code, stamp: hash(await fs.readFile(resolved.source, "utf8"))
      });
      return allPass;
    } finally {
      await fs.rm(result.directory, { recursive: true, force: true });
    }
  }

  testedCode(source: string): string | undefined {
    return this.tested.get(source)?.code;
  }

  private async chooseLanguage(problem: Problem, source: string, requested?: string): Promise<string> {
    if (requested) {
      if (!problem.languages.includes(requested))
        throw new Error("OJ 不支持指定的提交语言：" + requested);
      return requested;
    }
    const choices = submissionLanguageChoices(problem, source);
    if (choices.length === 1) return choices[0];
    if (!choices.length)
      throw new Error("OJ 不支持此源文件的语言，或语言选项无法识别。");
    if (!interactive())
      throw new Error("请通过 --lang 指定 OJ 提交语言：" + choices.join(", "));
    const chosen = await select("选择 OJ 语言", choices.map((value) =>
      ({ value, label: value })));
    if (!chosen) throw new Error("已取消提交。");
    return chosen;
  }

  async submit(
    resolved: ResolvedProblem, lang?: string, codeSnapshot?: string
  ): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    let prepared: { source: string; code: string };
    if (codeSnapshot === undefined) {
      prepared = await this.prepare(resolved);
    } else {
      const tested = this.tested.get(resolved.source);
      if (!tested || tested.code !== codeSnapshot)
        throw new Error("找不到对应的通过测试的源码快照，请重新测试。");
      const current = hash(await fs.readFile(resolved.source, "utf8"));
      if (current !== tested.stamp)
        throw new Error("测试后源码发生修改，请重新测试。");
      const ext = path.extname(resolved.source).toLowerCase();
      const submissionPath = path.join(path.dirname(resolved.source),
        ".accoding", "tested-submit" + ext);
      await fs.mkdir(path.dirname(submissionPath), { recursive: true });
      await fs.writeFile(submissionPath, codeSnapshot, "utf8");
      prepared = { source: submissionPath, code: codeSnapshot };
    }
    const storage = path.join(resolved.root, ".accoding", "runs");
    const checked = await compile(prepared.source, storage,
      await this.configuredToolchain(), undefined, false, path.dirname(resolved.source));
    try {
      if (checked.result.exitCode !== 0 || checked.result.reason)
        throw new Error("提交前编译失败，未上传：\n" + checked.result.stderr);
    } finally {
      await fs.rm(checked.directory, { recursive: true, force: true });
    }
    const problem = resolved.binding.problem;
    console.log("即将提交：" + problem.label + " " + problem.title +
      "（" + path.basename(resolved.source) + "）");
    let attemptId: string | undefined;
    const store = new SubmissionStore(path.join(resolved.root, ".accoding", "submissions"));
    try {
      const sent = await sendSubmission(this.session.client, problem.target,
        prepared.code, {
          language: (current) => this.chooseLanguage(current, resolved.source, lang),
          sending: async (target, language) => {
            const attempt = await store.begin(account, {
              target,
              language,
              sourceHash: hash(prepared.code)
            });
            attemptId = attempt.attemptId;
          }
        });
      if (!sent) {
        console.log("已取消提交。");
        return;
      }
      await store.observe(account, sent, attemptId);
      const submissionBinding = bindingId(sent.target);
      if (submissionBinding !== resolved.binding.bindingId)
        console.log("注意：本次转为题库提交，不计入原比赛成绩。");
      await this.state.recordVerdict(resolved.root, submissionBinding, account, sent.result);
      console.log("提交 ID：" + sent.id + "，OJ 状态：" + sent.result);
      if (isPending(sent)) await this.status(resolved.root, true);
    } catch (error) {
      if (attemptId) await store.uncertain(account, attemptId);
      throw error;
    }
  }

  async status(rootArg?: string, watch = false): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    const root = await this.workspaceRoot(rootArg);
    const store = new SubmissionStore(path.join(root, ".accoding", "submissions"));
    const attempts = await store.list(account);
    const uncertain = attempts.filter((entry) =>
      entry.state === "UnknownOutcome" || entry.state === "Sending");
    // Only the problemset adapter can verify the submitted source itself.
    // Never infer an identity from timing alone and never retry an unknown POST.
    for (const attempt of uncertain) {
      if (attempt.target.kind !== "problemset" || !attempt.sourceHash) continue;
      try {
        const adapter = new ProblemsetAdapter(
          attempt.target.service === "admin"
            ? this.session.client.adminReader() : this.session.client);
        const recovered = await adapter.recoverAttempt(attempt.target, account, attempt);
        if (!recovered) continue;
        await store.observe(account, recovered, attempt.attemptId);
        await this.state.recordVerdict(root, bindingId(recovered.target),
          account, recovered.result);
        console.log("已核实并恢复提交 ID：" + recovered.id);
      } catch (error) {
        console.warn("无法核实历史提交，已保留未决状态：" +
          (error instanceof Error ? error.message : String(error)));
      }
    }
    const refreshed = await store.list(account);
    const pending = refreshed.filter((entry) =>
      entry.state === "Pending" && entry.submission && isPending(entry.submission));
    const unresolved = refreshed.filter((entry) =>
      entry.state === "UnknownOutcome" || entry.state === "Sending");
    if (unresolved.length)
      console.log(unresolved.length +
        " 条提交结果仍不确定；不会自动重发，请到 Accoding 核对。");
    if (!pending.length) {
      console.log("没有待查询的远程评测。");
      return;
    }
    const get = async (previous: NonNullable<typeof pending[number]["submission"]>) => {
      const target = previous.target;
      return target.kind === "contest"
        ? new ContestAdapter(this.session.client).get(target, previous.id)
        : new ProblemsetAdapter(target.service === "admin"
          ? this.session.client.adminReader() : this.session.client).get(target, previous.id);
    };
    const update = async (submission: NonNullable<typeof pending[number]["submission"]>) => {
      const attempt = pending.find((entry) =>
        entry.submission?.id === submission.id &&
        bindingId(entry.submission.target) === bindingId(submission.target));
      await store.observe(account, submission, attempt?.attemptId);
      await this.state.recordVerdict(root, bindingId(submission.target), account,
        submission.result);
      console.log("题 " + submission.target.problemId + " / " +
        submission.id + "：" + submission.result);
    };
    if (!watch) {
      for (const attempt of pending)
        await update(await get(attempt.submission!));
      return;
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on("SIGINT", interrupt);
    try {
      const result = await monitorSubmissions({
        submissions: pending.map((entry) => entry.submission!),
        signal: controller.signal,
        get, update, intervalMs: 2000, budgetMs: 180000
      });
      if (result === "waiting") console.log("评测尚未完成，稍后运行 accoding status 继续查询。");
      if (result === "stopped") console.log("已停止等待，远程提交不会撤回。");
    } finally {
      process.off("SIGINT", interrupt);
    }
  }

  async list(rootArg?: string): Promise<ResolvedProblem[]> {
    const root = await this.workspaceRoot(rootArg);
    const workspace = new WorkspaceStore(root);
    const bindings = (await workspace.list()).filter((b) => !b.unavailable);
    const state = await this.state.load();
    const account = this.session.user?.id ?? state.lastAccount ?? "offline";
    const entries = await Promise.all(bindings.map(async (binding) => {
      const source = sourceFor(binding, root);
      const activity = this.state.getActivity(state, root, binding.bindingId, account);
      let modified = 0;
      const known = defaultSourceFiles(binding.problem.target);
      const base = binding.problemDirectory ?? path.posix.dirname(known.c);
      for (const file of [source,
        localPath(root, path.posix.join(base, "main.c")),
        localPath(root, path.posix.join(base, "main.cpp"))]) {
        try { modified = Math.max(modified, (await fs.stat(file)).mtimeMs); }
        catch { /* Optional source may not exist. */ }
      }
      return {
        root, workspace, binding,
        source: activity.sourceFile || source,
        modified: Math.max(modified, Date.parse(activity.lastActiveAt || "") || 0),
        verdict: activity.verdict,
        accepted: activityAccepted(activity),
        last: this.state.isLastProblem(state, root, binding.bindingId, account)
      };
    }));
    entries.sort((a, b) =>
      Number(a.accepted) - Number(b.accepted) ||
      b.modified - a.modified ||
      Number(b.last) - Number(a.last) ||
      a.binding.problem.label.localeCompare(b.binding.problem.label));
    return entries.map(({ root, workspace, binding, source }) =>
      ({ root, workspace, binding, source }));
  }

  async selectSource(problem: ResolvedProblem): Promise<ResolvedProblem> {
    const files = defaultSourceFiles(problem.binding.problem.target);
    const base = problem.binding.problemDirectory ?? path.posix.dirname(files.c);
    const result = await select("选择源码语言", [
      { label: "C (.c)", value: path.posix.join(base, "main.c") },
      { label: "C++ (.cpp)", value: path.posix.join(base, "main.cpp") }
    ]);
    if (!result) return problem;
    const source = localPath(problem.root, result);
    const binding = await problem.workspace.update(
      problem.binding.bindingId, problem.binding.revision,
      (b) => { b.sourceFile = result; delete b.selectedSubmissionLanguage; }
    );
    return { ...problem, binding, source };
  }

  dispose() { this.session.dispose(); }
}
