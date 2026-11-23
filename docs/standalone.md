# Standalone Accoding TUI / CLI (development preview)

This is a standalone TypeScript/Bun client. It reuses the original VS Code extension's Accoding adapters, local judge, and submission state machine. The VS Code extension is kept unchanged during migration. Real OJ account acceptance and packaged Windows/macOS builds remain to be verified.

## Commands

- accoding : TUI, with the latest non-AC problem by default
- accoding login / logout : account management
- accoding contest init ID-or-URL : initialize every accessible contest problem
- accoding problem init ID-or-URL : initialize one problem
- accoding sync : manually sync previously imported problems and contests
- accoding test /absolute/path/main.c : compile and run official samples
- accoding submit /absolute/path/main.c : explicit OJ submission
- accoding file /absolute/path/main.c : file-specific action menu
- accoding status --watch : monitor outstanding submissions
- accoding config preset /path/to/manifest.json : choose a custom default C99 scaffold
- accoding config preset default : restore the embedded example

Options: --root DIR for workspace commands, --preset MANIFEST during init, --lang VALUE for explicit OJ language. Environment variables ACCODING_CC and ACCODING_CXX select compilers. The standalone executable includes Bun but not GCC/Clang.

## User experience

Run the executable, log in, and start a contest or import one problem. Work in an external editor. The terminal starts with the last active unsolved problem; accepted problems are in a submenu. Testing all official samples successfully prompts whether to submit. Noninteractive editor tasks never block for confirmation; they display results and users invoke a separate submit command.

The tool copies the selected scaffold preset into each question folder and generates exam.h and main.c for C99. Submission and testing use **immutable, content-addressed** source snapshots under each problem's `.accoding/generated/` directory, assembled from referenced functions and transitive dependencies. This prevents simultaneous editor tasks from overwriting the file being compiled. The original files are preserved, and source edits during an ongoing test prevent the subsequent tested-snapshot submission. C++17 supports standard compile/test/submit without the C99 toolbox. Custom test editing and rich problem rendering are outside v0.1.

The local OJ session uses macOS Keychain or Windows DPAPI; Linux currently has session-only storage. Submission IDs are stored for pending verdict queries. Network POST is never automatically re-sent when the outcome is uncertain. Only OJ AC hides a task as solved; post-contest problemset acceptance is not counted as contest AC.



A repeated import of the same contest does not reset the active task to its first question; the default on a newly imported contest is the first non-AC problem after a best-effort verdict refresh.

## P0 directory selection and readable names

For a new contest, the terminal proposes \`~/Accoding/<contest title>/\`; you may paste or drag a Finder/Explorer folder into the prompt. The chosen folder becomes the **workspace root**. It then contains readable problem folders such as \`A-字符统计/\` instead of numeric directories. A single imported problem gets a suggested directory named after the problem. Invalid filename characters are removed and collisions get an ID suffix.

The CLI can bypass the interactive prompt:

~~~sh
accoding contest init 1234 --root "/Users/you/Documents/C语言练习/第七次作业"
~~~

Existing numeric workspaces are never renamed. They continue to work with their original internal metadata. Friendly workspaces store contest rosters in \`.better-accoding/rosters/\`, not a visible \`contests/<id>/\` folder.

## Importing the real exam-kit preset

The preset remains owned by the [independent c-exam-kit repository](https://github.com/Annouimo/c-exam-kit/tree/feat/lightweight-io-standalone-preset). Clone it locally (or extract a ZIP), then set its directory or manifest as the CLI default:

~~~sh
accoding config preset "/Users/you/c-exam-kit/scaffold/presets/exam-io-c99"
# or:
accoding config preset "/Users/you/c-exam-kit/scaffold/presets/exam-io-c99/manifest.json"
~~~

Drag-and-drop also works in the TUI settings. Each new question receives an immutable **snapshot** of the selected version; updates to c-exam-kit do not change already initialized question code. The integration CI compiles the actual input/output macros including \`read_ints\` and \`print_ints\` into a standalone C99 source file.

## Where data lives

Run \`accoding config paths\` to display local paths. On macOS, normal state is in \`~/.config/accoding-tui/state.json\`; passwords and serialized cookie sessions, if the user opts to stay logged in, are in Keychain under the \`Annouimo.AccodingTUI\` service. On Windows, settings are under \`%APPDATA%\\accoding-tui\` and DPAPI-encrypted secrets are in the same directory. The login prompt now offers a **session-only** choice, which retains neither cookie nor credentials after process exit. Per-problem samples, submission states, code and scaffold snapshots live in the selected workspace.

A macOS Keychain adapter still uses the \`security\` executable with short-lived encoded credential arguments; replacing it with a native binding remains a hardening task before final release.

## Safety and limitations

The local judge executes user source with the user's permissions; it is not a sandbox. The tool is not authorized by default for coursework examinations, even if reference material is allowed. No AI is used at runtime. Credentials must not be committed. macOS Keychain CLI currently passes the encrypted-store value through short-lived process arguments; a future native adapter could improve this.

The repo already includes scaffold format instructions in scaffold/README.md and editor task examples in examples/editor. Check with npm ci, npm run typecheck, npm run test:standalone and npm run build:standalone. Do not ship a release until real OJ and Windows/macOS runtime checks pass.
