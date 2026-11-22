import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";

export function interactive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  if (!interactive()) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error("This command requires a terminal. Provide its arguments explicitly.");
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const value = (await rl.question(
      question + (defaultValue ? " [" + defaultValue + "]" : "") + ": "
    )).trim();
    return value || defaultValue || "";
  } finally {
    rl.close();
  }
}

/** Password input without terminal echo; Ctrl-C cancels, Enter finishes. */
export async function password(question = "密码"): Promise<string> {
  if (!interactive() || !stdin.setRawMode)
    throw new Error("Password entry requires an interactive terminal.");
  stdout.write(question + ": ");
  const wasRaw = stdin.isRaw;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let input = "";
    const cleanup = () => {
      stdin.off("keypress", receive);
      stdin.setRawMode(Boolean(wasRaw));
      stdout.write("\n");
      stdin.pause();
    };
    function receive(char: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) {
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        cleanup();
        reject(new Error("Cancelled"));
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(input);
      } else if (key.name === "backspace") {
        if (input.length) input = input.slice(0, -1);
      } else if (char && !key.ctrl && !key.sequence?.startsWith("\x1b") &&
                 char !== "\r" && char !== "\n") {
        input += char;
      }
    }
    stdin.on("keypress", receive);
  });
}

export async function select(
  title: string, options: { label: string; value: string }[],
  defaultIndex = 0
): Promise<string | undefined> {
  if (!interactive()) throw new Error("Menu interaction requires an interactive terminal.");
  while (true) {
    console.log("\n" + title);
    options.forEach((option, index) => console.log(
      "  " + (index + 1) + ". " + option.label
    ));
    console.log("  0. 返回");
    const raw = await ask("选择编号", String(defaultIndex + 1));
    const number = Number(raw);
    if (raw === "0") return undefined;
    if (Number.isInteger(number) && number >= 1 && number <= options.length)
      return options[number - 1].value;
    console.log("无效的编号。");
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!interactive()) return false;
  const answer = (await ask(question + (defaultYes ? " [Y/n]" : " [y/N]"))).toLowerCase();
  return answer === "y" || answer === "yes" ||
    (answer === "" && defaultYes);
}
