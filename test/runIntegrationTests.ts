import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import {
  downloadAndUnzipVSCode,
  runTests
} from "@vscode/test-electron";

const vscodeVersion = "1.91.1";
const projectRoot = path.resolve(__dirname, "../..");
const extensionTestsPath = path.join(
  projectRoot,
  "out",
  "test",
  "integration",
  "suite.js"
);

function commandPath(command: string): string | undefined {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const candidate = result.stdout.split(/\r?\n/u)[0]?.trim();
  return candidate && existsSync(candidate) ? candidate : undefined;
}

function installedCandidates(): string[] {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    return [
      ...(localAppData
        ? [path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe")]
        : []),
      ...(programFiles
        ? [path.join(programFiles, "Microsoft VS Code", "Code.exe")]
        : [])
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      path.join(
        process.env.HOME ?? "",
        "Applications",
        "Visual Studio Code.app",
        "Contents",
        "MacOS",
        "Electron"
      )
    ];
  }
  return [
    "/usr/share/code/code",
    "/usr/local/share/code/code",
    "/opt/visual-studio-code/code",
    "/snap/bin/code"
  ];
}

async function resolveVscodeExecutable(): Promise<string> {
  const configured = process.env.VSCODE_EXECUTABLE_PATH;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(
        `VSCODE_EXECUTABLE_PATH does not exist: ${configured}`
      );
    }
    return configured;
  }

  const discovered = [
    commandPath("code"),
    commandPath("code-insiders"),
    ...installedCandidates()
  ].find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  );
  if (discovered) {
    return discovered;
  }

  return downloadAndUnzipVSCode({
    version: vscodeVersion,
    timeout: 120_000
  });
}

async function startXvfb(): Promise<ChildProcess | undefined> {
  if (process.platform !== "linux" || process.env.DISPLAY) {
    return undefined;
  }
  const executable = commandPath("Xvfb");
  if (!executable) {
    throw new Error(
      "DISPLAY is unset and Xvfb was not found on PATH; install Xvfb or set DISPLAY"
    );
  }

  const display = `:${100 + (process.pid % 500)}`;
  const child = spawn(
    executable,
    [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp", "-ac"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  process.env.DISPLAY = display;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 750);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Xvfb exited before startup (code ${String(code)}, signal ${String(signal)})`
        )
      );
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return child;
}

async function runSmoke(
  vscodeExecutablePath: string,
  mode: "proposed" | "no-flag"
): Promise<void> {
  const workRoot = path.join(projectRoot, ".test-work", mode);
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(path.join(workRoot, "workspace"), { recursive: true });

  const launchArgs = [
    path.join(workRoot, "workspace"),
    "--disable-extensions",
    "--disable-gpu",
    "--disable-updates",
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--skip-welcome",
    `--user-data-dir=${path.join(workRoot, "user-data")}`,
    `--extensions-dir=${path.join(workRoot, "extensions")}`
  ];
  if (mode === "proposed") {
    launchArgs.push("--enable-proposed-api=local.branch-diff");
  }

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath,
    extensionTestsEnv: {
      BRANCH_DIFF_SMOKE_MODE: mode
    },
    launchArgs
  });
}

async function main(): Promise<void> {
  const xvfb = await startXvfb();
  try {
    const vscodeExecutablePath = await resolveVscodeExecutable();
    console.log(`Using VS Code executable: ${vscodeExecutablePath}`);
    await runSmoke(vscodeExecutablePath, "proposed");
    await runSmoke(vscodeExecutablePath, "no-flag");
  } finally {
    if (xvfb?.pid !== undefined) {
      xvfb.kill("SIGTERM");
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
