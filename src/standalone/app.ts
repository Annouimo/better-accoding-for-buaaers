#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { StandaloneWorkflow, type ResolvedProblem } from "./workflow";
import { ask, confirm, interactive, select } from "./terminal";
import { isAccepted } from "./state";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error("缺少参数 " + name);
  return value;
}

function usage() {
  console.log([
    "Accoding TUI / CLI",
    "",
    "  accoding                         打开简洁 TUI",
    "  accoding login                   首次登录",
    "  accoding logout                  退出登录",
    "  accoding contest init ID|URL     初始化整场比赛",
    "  accoding problem init ID|URL     初始化单题",
    "  accoding test PATH               测试当前 C/C++ 源文件",
    "  accoding submit PATH             提交源文件",
    "  accoding file PATH               当前文件的简洁操作菜单",
    "  accoding status                  查询等待中的 OJ 评测",
    "  accoding sync                    手动同步题目与比赛",
    "",
    "  --root DIR                       指定工作区（初始化/同步/查询）",
    "  --preset MANIFEST                初始化时使用自定义 C99 配置",
    "  --lang LANGUAGE                  指定 OJ 提交语言",
    "",
    "双击启动可进入 TUI。编辑器只需要 test 和 submit 两个命令。",
    "C 语言的单文件提交会按需展开 exam.h；C++ 不引入该函数库。"
  ].join("\n"));
}

async function runTest(app: StandaloneWorkflow, resolved: ResolvedProblem): Promise<boolean> {
  const passed = await app.test(resolved);
  if (passed && await confirm("所有本地样例通过。是否提交到 Accoding？")) {
    // Submit the immutable bytes that passed local testing.
    await app.submit(resolved, undefined, app.testedCode(resolved.source));
  }
  return passed;
}

async function openFolder(source: string): Promise<void> {
  const folder = path.dirname(source);
  const executable = process.platform === "win32" ? "explorer.exe" :
    process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(executable, [folder], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.once("error", (error) => console.error("无法打开文件夹：" + error.message));
  child.unref();
}

async function fileMenu(
  app: StandaloneWorkflow, problem: ResolvedProblem
): Promise<void> {
  for (;;) {
    const choice = await select(
      problem.binding.problem.label + " · " + problem.binding.problem.title +
        "\n源码：" + path.basename(problem.source),
      [
        { label: "测试（通过后询问是否提交）", value: "test" },
        { label: "直接提交", value: "submit" },
        { label: "切换 C / C++", value: "language" },
        { label: "打开代码文件夹", value: "folder" }
      ]
    );
    if (!choice) return;
    if (choice === "test") await runTest(app, problem);
    else if (choice === "submit") {
      if (await confirm("确认提交当前源文件？"))
        await app.submit(problem);
    } else if (choice === "language") problem = await app.selectSource(problem);
    else if (choice === "folder") await openFolder(problem.source);
  }
}

async function chooseProblem(
  app: StandaloneWorkflow, onlyAccepted: boolean
): Promise<ResolvedProblem | undefined> {
  const items = await app.list();
  const state = await app.state.load();
  const account = app.session.user?.id ?? state.lastAccount ?? "offline";
  const relevant = items.filter((entry) =>
    isAccepted(app.state.getActivity(state, entry.root, entry.binding.bindingId, account)
      .verdict) === onlyAccepted);
  const selected = await select(onlyAccepted ? "已 AC 题目" : "尚未 AC 的题目",
    relevant.map((entry, index) => ({
      value: String(index),
      label: entry.binding.problem.label + " · " + entry.binding.problem.title +
        "  " +
        (app.state.getActivity(state, entry.root, entry.binding.bindingId, account)
          .verdict || "未提交")
    })));
  return selected === undefined ? undefined : relevant[Number(selected)];
}

async function tui(app: StandaloneWorkflow): Promise<void> {
  if (!interactive()) {
    usage();
    throw new Error("交互界面需要可输入的终端；自动化脚本请使用 CLI 子命令。");
  }
  let loggedIn: string | undefined;
  try {
    loggedIn = await app.account(false);
  } catch { /* Offline testing still works if a workspace is already available. */ }
  if (!loggedIn) {
    const first = await select("欢迎使用 Accoding。首次使用建议先登录。", [
      { label: "登录 Accoding", value: "login" },
      { label: "暂时跳过，使用已有本地工作区", value: "offline" }
    ]);
    if (first === "login") await app.login();
    if (first === undefined) return;
  }

  let current: ResolvedProblem | undefined;
  for (;;) {
    const all = await app.list();
    const state = await app.state.load();
    const account = app.session.user?.id ?? state.lastAccount ?? "offline";
    const pending = all.filter((entry) => !isAccepted(
      app.state.getActivity(state, entry.root, entry.binding.bindingId, account).verdict
    ));
    if (!current || !all.some((item) => item.binding.bindingId === current!.binding.bindingId))
      current = pending[0];
    if (!current && all.length) console.log("\n当前工作区的题目均已 AC。");

    const title = current
      ? "当前题目：" + current.binding.problem.label + " · " +
          current.binding.problem.title + "\n源文件：" + current.source
      : "Accoding · 暂无进行中的题目";
    const choices = current
      ? [
          { label: "测试（全部通过后询问是否提交）", value: "test" },
          { label: "切换题目", value: "choose" },
          { label: "更多操作", value: "more" }
        ]
      : [
          { label: "开始一场比赛", value: "contest" },
          { label: "导入一道题目", value: "problem" },
          { label: "更多操作", value: "more" }
        ];
    const action = await select(title, choices);
    if (action === undefined) return;
    if (action === "test" && current) await runTest(app, current);
    if (action === "choose") {
      const picked = await chooseProblem(app, false);
      if (picked) {
        current = picked;
        const lastAccount = app.session.user?.id ??
          (await app.state.load()).lastAccount ?? "offline";
        await app.state.rememberProblem(
          current.root, current.binding.bindingId, lastAccount,
          { sourceFile: current.source }
        );
      }
    }
    if (action === "contest") {
      const id = await ask("比赛 ID 或链接");
      if (id) {
        await app.importContest(id);
        current = undefined;
      }
    }
    if (action === "problem") {
      const id = await ask("题目 ID 或链接");
      if (id) {
        await app.importProblem(id);
        current = undefined;
      }
    }
    if (action === "more") {
      const extra = await select("更多操作", [
        { label: "开始新比赛", value: "contest" },
        { label: "导入单题", value: "problem" },
        { label: "查看已 AC 题目", value: "accepted" },
        { label: "手动同步比赛与题目", value: "sync" },
        { label: "查看待查询的 OJ 提交", value: "status" },
        { label: "切换 C / C++", value: "language" },
        { label: "打开当前题目的文件夹", value: "folder" },
        { label: "登录 / 切换账号", value: "login" },
        { label: "退出登录", value: "logout" }
      ]);
      if (extra === "contest") {
        const id = await ask("比赛 ID 或链接");
        if (id) { await app.importContest(id); current = undefined; }
      } else if (extra === "problem") {
        const id = await ask("题目 ID 或链接");
        if (id) { await app.importProblem(id); current = undefined; }
      } else if (extra === "accepted") {
        const picked = await chooseProblem(app, true);
        if (picked) await fileMenu(app, picked);
      } else if (extra === "sync") await app.sync();
      else if (extra === "status") await app.status();
      else if (extra === "language" && current) current = await app.selectSource(current);
      else if (extra === "folder" && current) await openFolder(current.source);
      else if (extra === "login") await app.login();
      else if (extra === "logout") await app.logout();
    }
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { usage(); return; }
  const app = new StandaloneWorkflow();
  try {
    const root = option(args, "--root");
    const preset = option(args, "--preset");
    const lang = option(args, "--lang");
    const command = args[0];
    if (!command) { await tui(app); return; }
    if (command === "login") { await app.login(); return; }
    if (command === "logout") { await app.logout(); return; }
    if (command === "contest" && args[1] === "init" && args[2]) {
      await app.importContest(args[2], root, preset);
      return;
    }
    if (command === "problem" && args[1] === "init" && args[2]) {
      await app.importProblem(args[2], root, preset);
      return;
    }
    if (command === "test" && args[1]) {
      const passed = await runTest(app, await app.resolve(args[1]));
      if (!passed) process.exitCode = 1;
      return;
    }
    if (command === "submit" && args[1]) {
      await app.submit(await app.resolve(args[1]), lang);
      return;
    }
    if (command === "file" && args[1]) {
      await fileMenu(app, await app.resolve(args[1]));
      return;
    }
    if (command === "sync") { await app.sync(root); return; }
    if (command === "status") { await app.status(root); return; }
    usage();
    throw new Error("不支持的命令。");
  } finally {
    app.dispose();
  }
}

run().catch((error: unknown) => {
  console.error("错误：" + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
