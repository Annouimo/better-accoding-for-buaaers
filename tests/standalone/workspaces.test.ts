import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../src/workspace/store";
import { StandaloneWorkflow } from "../../src/standalone/workflow";
import { StateStore, activityAccepted } from "../../src/standalone/state";
import { droppedPath, readableName, initializeFriendlyLayout,
  isFriendlyWorkspace, readableProblemDirectory } from "../../src/standalone/workspaces";

test("Finder dropped paths and Windows-safe user-facing names", () => {
  assert.equal(droppedPath("'~/C projects/示例'", "/tmp", "/Users/test"),
    path.resolve("/Users/test/C projects/示例"));
  assert.equal(droppedPath("~/C\\ projects/示例", "/tmp", "/Users/test"),
    path.resolve("/Users/test/C projects/示例"));
  assert.equal(readableName('A:字符/统计*?'), "A 字符 统计");
  assert.equal(readableName("CON"), "_CON");
  assert.equal(readableName("..."), "未命名");
});

test("new friendly workspace works and legacy sources are preserved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-friendly-"));
  try {
    assert.equal(await initializeFriendlyLayout(root), true);
    assert.equal(await isFriendlyWorkspace(root), true);
    const store = new WorkspaceStore(root);
    const problem = {
      target: { kind: "problemset", problemId: "987654" },
      title: "数组/求和",
      label: "A",
      statement: { format: "html", content: "<p>Example</p>", baseUrl: "https://accoding.buaa.edu.cn" },
      languages: ["c", "cpp"], samples: [{ key: "sample-1", input: "1\n", expected: "1\n" }],
      warnings: [], special: false
    };
    const friendly = await readableProblemDirectory(root, problem);
    assert.equal(friendly, "题目-数组 求和");
    const entry = await store.import(problem, friendly);
    assert.equal(entry.sourceFile, friendly + "/main.c");
    assert.equal(entry.problemDirectory, friendly);
    assert.equal(await fs.readFile(path.join(root, friendly, "main.c"), "utf8").then(Boolean), true);
    assert.equal(await fs.stat(path.join(root, friendly, "tests", "tests.json")).then(x => x.isFile()), true);
    assert.equal((await store.list())[0].problemDirectory, friendly);
    const another = await readableProblemDirectory(root, problem);
    assert.match(another, /987654$/);
    assert.equal(await initializeFriendlyLayout(root), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy numeric layout never gets silently migrated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-legacy-"));
  try {
    await fs.mkdir(path.join(root, "contests", "123"), { recursive: true });
    assert.equal(await initializeFriendlyLayout(root), false);
    assert.equal(await isFriendlyWorkspace(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("remote verdict refresh does not change last-active problem", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-state-focus-"));
  try {
    const state = new StateStore(path.join(root, "user-state.json"));
    await state.rememberProblem(root, "contest-1-2", "user1");
    const first = await state.load();
    const activity = state.getActivity(first, root, "contest-1-2", "user1");
    await state.recordVerdict(root, "contest-1-1", "user1", "AC");
    const updated = await state.load();
    assert.equal(updated.lastProblem, first.lastProblem);
    assert.equal(state.getActivity(updated, root, "contest-1-2", "user1").lastActiveAt,
      activity.lastActiveAt);
    assert.equal(activityAccepted(state.getActivity(updated, root, "contest-1-1", "user1")), true);
    await state.recordVerdict(root, "contest-1-1", "user1", "WA");
    assert.equal(activityAccepted(state.getActivity(await state.load(), root,
      "contest-1-1", "user1")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
