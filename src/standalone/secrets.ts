import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { configDirectory } from "./state";

interface SecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = "Annouimo.AccodingTUI";
const VALID_KEY = /^[a-z][a-z0-9.]*$/;

function validKey(key: string): string {
  if (!VALID_KEY.test(key)) throw new Error("Invalid credential key");
  return key;
}

async function command(
  executable: string, args: string[], input?: string
): Promise<{ stdout: string; stderr: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ stdout, stderr, status: status ?? 1 }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

class MacKeychain implements SecretStorage {
  async get(key: string): Promise<string | undefined> {
    const result = await command("security", [
      "find-generic-password", "-a", validKey(key), "-s", SERVICE, "-w"
    ]);
    if (result.status !== 0) {
      if (/could not be found|The specified item could not be found/i.test(result.stderr))
        return undefined;
      throw new Error("Unable to read macOS Keychain: " + result.stderr.trim());
    }
    return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  }
  async store(key: string, value: string): Promise<void> {
    // Keychain stores credentials encrypted. The security CLI uses an argv value;
    // avoid writing it to app logs and do not include it in thrown errors.
    const encoded = Buffer.from(value, "utf8").toString("base64");
    const result = await command("security", [
      "add-generic-password", "-a", validKey(key), "-s", SERVICE,
      "-U", "-w", encoded
    ]);
    if (result.status !== 0) throw new Error("Unable to store macOS Keychain credential.");
  }
  async delete(key: string): Promise<void> {
    const result = await command("security", [
      "delete-generic-password", "-a", validKey(key), "-s", SERVICE
    ]);
    if (result.status !== 0 &&
        !/could not be found|The specified item could not be found/i.test(result.stderr))
      throw new Error("Unable to delete macOS Keychain credential.");
  }
}

class WindowsDpapi implements SecretStorage {
  private location(key: string): string {
    return path.join(configDirectory(), validKey(key) + ".dpapi");
  }

  private async invoke(mode: "encrypt" | "decrypt", key: string, input?: string): Promise<string> {
    const file = this.location(key).replace(/'/g, "''");
    // No credential text is passed on the PowerShell command line.
    const script = mode === "encrypt"
      ? [
          "$ErrorActionPreference = 'Stop'",
          "$raw = [Console]::In.ReadToEnd()",
          "$secure = ConvertTo-SecureString -String $raw -AsPlainText -Force",
          "$encrypted = ConvertFrom-SecureString -SecureString $secure",
          "Set-Content -LiteralPath '" + file + "' -Value $encrypted -Encoding UTF8"
        ].join("; ")
      : [
          "$ErrorActionPreference = 'Stop'",
          "$encrypted = (Get-Content -LiteralPath '" + file + "' -Raw).Trim()",
          "$secure = ConvertTo-SecureString $encrypted",
          "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
          "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }",
          "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }"
        ].join("\n");
    const result = await command("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script
    ], input);
    if (result.status !== 0)
      throw new Error("Windows DPAPI credential operation failed.");
    return result.stdout;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      await fs.access(this.location(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return this.invoke("decrypt", key);
  }

  async store(key: string, value: string): Promise<void> {
    await fs.mkdir(configDirectory(), { recursive: true });
    await this.invoke("encrypt", key, value);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.location(key), { force: true });
  }
}

class SessionOnlySecrets implements SecretStorage {
  private memory = new Map<string, string>();
  async get(key: string) { return this.memory.get(validKey(key)); }
  async store(key: string, value: string) { this.memory.set(validKey(key), value); }
  async delete(key: string) { this.memory.delete(validKey(key)); }
}

export function credentialsBackend(): {
  store: SecretStorage;
  persistent: boolean;
  description: string;
} {
  if (process.platform === "darwin")
    return { store: new MacKeychain(), persistent: true, description: "macOS Keychain" };
  if (process.platform === "win32")
    return { store: new WindowsDpapi(), persistent: true, description: "Windows DPAPI" };
  return {
    store: new SessionOnlySecrets(), persistent: false,
    description: "session memory (no Linux keyring backend configured)"
  };
}
