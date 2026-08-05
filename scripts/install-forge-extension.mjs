#!/usr/bin/env node
//
// Install the Forge prefill extension.  `pnpm setup:forge [path-to-webui]`
//
// The extension lives in this repo rather than only inside a webui install,
// because a webui gets reinstalled, moved between drives and occasionally
// wiped — and the extension is ours, not theirs. Keeping the source here means
// recovering it is one command instead of remembering what it did.
//
// Cross-platform Node rather than a shell script, for the same reason
// `setup-python.mjs` is: `bash` on Windows is the WSL relay and fails with an
// execvpe error when no distro is installed.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repo, "integrations", "forge-prefill");
const FOLDER = "luma-vault-prefill";

/**
 * Places a Forge or Automatic1111 install commonly lives.
 *
 * Only checked when no path is given. Deliberately short: guessing at length is
 * slower and less predictable than being told, and the failure message below
 * says exactly what to pass.
 */
function candidates() {
  const home = homedir();
  const names = ["stable-diffusion-webui-forge", "stable-diffusion-webui", "webui", "forge"];
  const roots = [
    join(home, "AI"),
    join(home, "Documents"),
    home,
    ...(process.platform === "win32"
      ? ["C:\\AI", "D:\\AI", "D:\\AI\\Stable Diffusion", "E:\\AI"]
      : ["/opt", "/srv"]),
  ];

  const found = [];
  for (const root of roots) {
    for (const name of names) {
      found.push(join(root, name));
    }
    // One level down too: `D:\AI\Stable Diffusion\webui` is the shape Forge's
    // own installer produces.
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          for (const name of names) found.push(join(root, entry.name, name));
        }
      }
    } catch {
      // An unreadable or absent root is not worth reporting: this is a guess.
    }
  }
  return found;
}

/** A webui install has an `extensions` directory and a launcher beside it. */
function isWebui(path) {
  try {
    if (!statSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    existsSync(join(path, "extensions")) &&
    (existsSync(join(path, "launch.py")) ||
      existsSync(join(path, "webui.py")) ||
      existsSync(join(path, "modules")))
  );
}

function findWebui(explicit) {
  if (explicit) {
    const path = resolve(explicit);
    if (!isWebui(path)) {
      fail(
        `${path} does not look like a webui install.`,
        "Expected an `extensions` directory and launch.py / modules beside it.",
      );
    }
    return path;
  }

  const fromEnv = process.env.LUMA_FORGE_DIR;
  if (fromEnv) {
    if (!isWebui(fromEnv)) fail(`LUMA_FORGE_DIR is set to ${fromEnv}, which is not a webui install.`);
    return resolve(fromEnv);
  }

  const guess = candidates().find(isWebui);
  if (guess) return guess;

  fail(
    "Could not find a Forge or Automatic1111 install.",
    "",
    "Pass the path to the folder containing `extensions`:",
    "",
    '    pnpm setup:forge "D:\\AI\\Stable Diffusion\\webui"',
    "",
    "Or set LUMA_FORGE_DIR once and re-run.",
  );
}

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const explicit = args.find((arg) => !arg.startsWith("--"));

if (!existsSync(source)) {
  fail(`The extension source is missing from this repo: ${source}`);
}

const webui = findWebui(explicit);
const target = join(webui, "extensions", FOLDER);

if (uninstall) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${target}`);
  } else {
    console.log(`Nothing to remove at ${target}`);
  }
  console.log("Restart Forge to unload it.");
  process.exit(0);
}

// Replaced wholesale rather than merged: this folder is entirely ours, and a
// stale file left behind by an older version is a bug nobody would think to
// look for.
rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  // Never the bytecode. Anything that has imported these modules — a test, an
  // editor — leaves a `__pycache__` behind, compiled by whichever interpreter
  // happened to run, which is not the one embedded in the webui. Python
  // invalidates a stale `.pyc` by timestamp so it would not actually be loaded,
  // but shipping another runtime's bytecode into someone else's install is the
  // kind of thing that gets blamed for the next unrelated failure.
  filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc"),
});

console.log(`Installed the Luma Vault prefill extension.`);
console.log(``);
console.log(`  from  ${source}`);
console.log(`  to    ${target}`);
console.log(``);
console.log(`Restart Forge for it to load. Then "Open in Forge" in the lightbox`);
console.log(`fills the txt2img tab directly instead of asking you to paste.`);
