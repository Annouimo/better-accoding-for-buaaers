# Scaffold preset contract (draft v1)

This folder contains **example configuration**, not the full exam toolbox. The actual C library is intentionally kept minimal while the library design is done separately.

## Layout

- `presets/example-c99/manifest.json` is the single manifest for the example preset.
- `components/*.h` contain ordinary, readable C99 snippets; put substantial C code in files rather than escaped JSON strings.
- User presets may use the same layout in any local directory; the CLI will accept a manifest path. The bundled example is a fallback, not a limit on customization.

## Manifest v1

- `schemaVersion`: must equal `1`.
- `id`: stable preset identifier; `language`: currently `c`; `standard`: currently `c99`.
- `headerFile`: generated per-problem header filename, e.g. `exam.h`.
- `systemHeaders`: standard C headers, written as `#include <...>` in the generated header and assembled submission.
- `components`: ordered component definitions. Each component has `id`, `description`, `symbols` (identifier names exposed to user code), `source` (UTF-8 path relative to this manifest), and `requires` (other component IDs).

### Expected behavior

1. Initialization writes a **copy** of the selected preset header beside `main.c`; it never overwrites user files.
2. The editor compiles `main.c` with `#include "exam.h"` as usual.
3. `test` and `submit` assemble a **separate** self-contained C99 source by replacing the local exam header include with only required components and transitive dependencies. Neither command edits `main.c` or `exam.h`.
4. Detection is deliberately conservative: scan C identifiers outside comments and string/character literals; select components with matching `symbols`; recursively add `requires` in dependency order. There is no general C AST analysis. A component is an indivisible unit.
5. Reject unknown/cyclic dependencies, duplicate exported symbols, missing or unsafe source paths, and unsupported local includes rather than silently producing incorrect code. Check the assembled file with the configured C compiler before OJ submission.
6. C++ initialization, testing, and submission remain supported, but this C99 preset is **not** injected into `.cpp` files.

`example-c99` intentionally demonstrates only `exam_gcd_u64` and `exam_lcm_u64`. The latter depends on the former. The real library can replace or extend this preset without changing the OJ client or TUI.

### Sample usage

```c
#include <stdio.h>
#include "exam.h"

int main(void) {
    printf("%llu\n", exam_lcm_u64(12, 18));
    return 0;
}
```

The expected output is `36`. Both functions are needed and should be bundled once; using only `exam_gcd_u64` must not include `exam_lcm_u64`.

## Versioning & compatibility

`schemaVersion` is the configuration **format version**, not the library release version. Unknown schema versions fail with an actionable message. Future optional fields must not change how v1 entries are interpreted. Keep a snapshot of the selected preset per initialized workspace, so later updates to the global preset do not silently change existing solutions.
