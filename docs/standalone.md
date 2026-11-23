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

The tool copies the selected scaffold preset into each question folder and generates exam.h and main.c for C99. Submission and testing use a separate source assembled from referenced functions plus transitive dependencies, preserving the original files. C++17 supports standard compile/test/submit without the C99 toolbox. Custom test editing and rich problem rendering are outside v0.1.

The local OJ session uses macOS Keychain or Windows DPAPI; Linux currently has session-only storage. Submission IDs are stored for pending verdict queries. Network POST is never automatically re-sent when the outcome is uncertain. Only OJ AC hides a task as solved; post-contest problemset acceptance is not counted as contest AC.

## Safety and limitations

The local judge executes user source with the user's permissions; it is not a sandbox. The tool is not authorized by default for coursework examinations, even if reference material is allowed. No AI is used at runtime. Credentials must not be committed. macOS Keychain CLI currently passes the encrypted-store value through short-lived process arguments; a future native adapter could improve this.

The repo already includes scaffold format instructions in scaffold/README.md and editor task examples in examples/editor. Check with npm ci, npm run typecheck, npm run test:standalone and npm run build:standalone. Do not ship a release until real OJ and Windows/macOS runtime checks pass.
