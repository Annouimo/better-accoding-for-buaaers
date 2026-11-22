# Independent Accoding CLI — implementation notes

This is an **early prototype**, not the completed Accoding TUI. The existing VS Code extension is preserved during migration.

## Implemented on this development branch

- Load and validate a versioned external C99 scaffold preset.
- Generate a local `exam.h` and starter `main.c` without overwriting existing files.
- Snapshot the chosen preset under each problem directory in `.accoding/scaffold/`.
- Expand only C99 components referenced by `main.c` (plus declared transitive dependencies), into `.accoding/submit.c`.
- Compile-check the expanded source through a local C compiler. Neither the user's C file nor `exam.h` is modified.
- Reject unsupported local includes, unsafe preset source paths, duplicate exported symbols, missing/cyclic dependencies.

From the repository root, with Bun installed and a C compiler on PATH:

```sh
bun src/standalone/cli.ts scaffold init ./scratch/demo
bun src/standalone/cli.ts scaffold prepare ./scratch/demo/main.c
npm run test:standalone
```

The generated example `main.c` does not call a library function. To verify dependency expansion, edit it to call `exam_lcm_u64`, then rerun `prepare`. The example preset is intentionally tiny: the function library is being designed separately.

To use your own preset:

```sh
bun src/standalone/cli.ts scaffold init ./scratch/custom --preset /path/to/manifest.json
```

`prepare` uses the workspace snapshot by default, making projects reproducible when a global preset changes. **Do not submit `.accoding/submit.c` manually until its compilation check succeeds.** It is a generated artifact.

## Not yet implemented

- Independent login, OJ import/sync, submission, pending verdict recovery.
- Main TUI and editor tasks.
- C++ scaffold expansion (ordinary C++ compiling/testing/submission remains planned).
- Bun executable release asset packaging; the checked-in example preset must be made discoverable in the packaged distribution.
- Full C-preprocessor or multi-translation-unit support. C99 preset composition is intentionally conservative.

## Integration contract

The upcoming `test` and `submit` commands will use the **same assembled immutable C snapshot**. On successful local tests, interactive TUI users will be asked whether to submit; a non-interactive editor task will not block waiting for terminal input. AC state and the last active problem will be tracked separately from source modification timestamps.

The current feature branch does not modify the VS Code extension or the existing Accoding service modules. It is meant to establish a tested, clean boundary before wiring up the imported core.
