#!/usr/bin/env node
//
// Picks the platform's setup script.  `pnpm setup:python`
//
// This exists because `bash scripts/setup-python.sh` cannot work on Windows:
// `bash` on PATH there is System32\bash.exe, the WSL relay, which fails with an
// execvpe error when no distro is installed — and even under Git Bash the POSIX
// script would look for venv-classifier/bin/python, which a Windows venv does
// not have (it is Scripts\python.exe).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));

const [command, args] =
  process.platform === "win32"
    ? [
        "powershell.exe",
        // -ExecutionPolicy Bypass: a fresh clone's .ps1 is unsigned, and the
        // default machine policy would refuse to run it.
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scripts, "setup-python.ps1")],
      ]
    : ["bash", [join(scripts, "setup-python.sh")]];

const { status, error } = spawnSync(command, args, { stdio: "inherit" });

if (error) {
  console.error(`error: could not run ${command}: ${error.message}`);
  process.exit(1);
}

process.exit(status ?? 1);
