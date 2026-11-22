import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../src/workspace/store";
import { StandaloneWorkflow } from "../../src/standalone/workflow";
import { StateStore, isAccepted } from "../../src/standalone/state";
import { builtinPreset } from "../../src/standalone/generated-preset";
import { renderHeader } from "../../src/standalone/scaffold";

test("state persists verdict per account and source path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-state-"));
  try {
    const state = new StateStore(path.join(root, "state.json"));
    await state.rememberProblem(root, "contest-123-1", "account-1", {
      verdict: "AC", sourceFile: path.join(root, "main.c")
    });
    const loaded = await state.load();
    expect(isAccepted(state.getActivity(loaded, root, "contest-123-1", "account-1").verdict))
      .toBe(true);
    expect(isAccepted(state.getActivity(loaded, root, "contest-123-1", "account-2").verdict))
      .toBe(false);
    expect(state.isLastProblem(loaded, root, "contest-123-1", "account-1")).toBe(true);
    expect(state.isLastProblem(loaded, root, "contest-123-2", "account-1")).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("standalone C and C++ judge share the same persisted official samples", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-workflow-"));
  const savedConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "configuration");
  const app = new StandaloneWorkflow();
  try {
    const workspace = new WorkspaceStore(root);
    await workspace.import({
      target: { kind: "problemset", problemId: "123" },
      title: "Offline example",
      label: "#123",
      statement: {
        format: "html",
        content: "",
        baseUrl: "https://accoding.buaa.edu.cn/problem/123/index"
      },
      languages: ["c", "cpp"],
      samples: [{ key: "sample-1", input: "", expected: "36\n" }],
      warnings: [],
      special: false
    });
    const folder = path.join(root, "problems", "123");
    const config = path.join(folder, ".accoding", "scaffold");
    await fs.mkdir(config, { recursive: true });
    const preset = builtinPreset();
    await fs.mkdir(path.join(config, "components"));
    for (const entry of preset.manifest.components)
      await fs.writeFile(path.join(config, entry.source), preset.code.get(entry.id)!);
    await fs.writeFile(path.join(config, "manifest.json"),
      JSON.stringify(preset.manifest));
    await fs.writeFile(path.join(folder, "exam.h"), renderHeader(preset));
    const source = path.join(folder, "main.c");
    await fs.writeFile(source,
      '#include <stdio.h>\n#include "exam.h"\n' +
      'int main(void) { printf("%llu\\n", exam_lcm_u64(12, 18)); return 0; }\n');
    const resolved = await app.resolve(source);
    expect(await app.test(resolved)).toBe(true);
    expect(app.testedCode(source)).toContain("static unsigned long long exam_lcm_u64");
    const prepared = await app.prepare(resolved);
    expect(prepared.code).not.toContain('#include "exam.h"');

    const cpp = path.join(folder, "main.cpp");
    await fs.writeFile(cpp,
      '#include <iostream>\nint main() { std::cout << 36 << "\\n"; }\n');
    const cppResolved = await app.resolve(cpp);
    expect(await app.test(cppResolved)).toBe(true);
    expect((await app.prepare(cppResolved)).code).not.toContain("exam_lcm_u64");
  } finally {
    app.dispose();
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfig;
    await fs.rm(root, { recursive: true, force: true });
  }
});
