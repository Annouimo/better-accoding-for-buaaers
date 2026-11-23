# Editor integration

The same binary serves Zed, VS Code and standalone Dev-C++ workflows. Two high-frequency actions are exposed: Test and Submit.

For Zed, copy zed-tasks.json to .zed/tasks.json in the workspace. Use the task picker or optionally assign keys in your personal keymap. For VS Code, copy vscode-tasks.json to .vscode/tasks.json and use Terminal > Run Task, optionally binding the task label through workbench.action.tasks.runTask. Both configurations save the active file before running.

For Dev-C++, the standalone Windows console TUI requires no editor setup. Some variants support Tools > Configure Tools to add an external command, but custom shortcuts, source macros, and whether the external tool gets its own console depend on the edition. The TUI is the guaranteed fallback; no edition-specific shortcuts are assumed.

The examples use executable name accoding, which must be on PATH. Replace the command with an absolute path if installed portably. An editor task without a TTY never blocks on the post-test confirmation prompt.
