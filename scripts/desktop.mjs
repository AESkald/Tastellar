import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = {
  ...process.env,
  TASTELLAR_DATA_DIR: resolve(root, ".runtime/development"),
  CARGO_TARGET_DIR: resolve(root, ".target"),
};
const cargoHome = resolve(root, ".tools/cargo");
const cargoExecutable = process.platform === "win32" ? "cargo.exe" : "cargo";
if (existsSync(resolve(cargoHome, "bin", cargoExecutable))) {
  env.CARGO_HOME = cargoHome;
  env.RUSTUP_HOME = resolve(root, ".tools/rustup");
  env.PATH = `${resolve(cargoHome, "bin")}${delimiter}${env.PATH}`;
}
const mode = process.argv[2] ?? "dev";
const requestedPlatform = process.argv[3];
const requestedBundle = process.argv[4];
let bundleTargets;
if (mode === "build") {
  if (process.argv.length > 5) {
    throw new Error("Usage: desktop.mjs build [macos|windows] [app|dmg|nsis].");
  }
  const platform = requestedPlatform ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : null);
  if (platform !== "macos" && platform !== "windows") {
    throw new Error("Desktop installers are built on macOS or Windows. Choose macos or windows.");
  }
  const allowedBundles = platform === "macos" ? ["app", "dmg"] : ["nsis"];
  if (requestedBundle && !allowedBundles.includes(requestedBundle)) {
    throw new Error(`The ${platform} build target must be one of: ${allowedBundles.join(", ")}.`);
  }
  const expectedHost = platform === "macos" ? "darwin" : "win32";
  if (process.platform !== expectedHost) {
    throw new Error(`The ${platform} installer must be built on ${platform === "macos" ? "macOS" : "Windows"}.`);
  }
  bundleTargets = requestedBundle ?? (platform === "macos" ? "app" : "nsis");
} else if (mode === "dev") {
  if (process.argv.length > 3) {
    throw new Error("Usage: desktop.mjs dev.");
  }
} else {
  throw new Error("Choose the desktop dev or build command.");
}
const args = [
  "run",
  "tauri",
  "--workspace",
  "@tastellar/app",
  "--",
  mode,
  ...(bundleTargets ? ["--bundles", bundleTargets] : []),
];
const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
