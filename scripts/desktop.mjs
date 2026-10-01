import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = {
  ...process.env,
  TASTELLAR_DATA_DIR: resolve(root, ".runtime/development"),
  CARGO_TARGET_DIR: resolve(root, ".target"),
};
const cargo = resolve(root, ".tools/cargo");
if (existsSync(resolve(cargo, "bin/cargo"))) {
  env.CARGO_HOME = cargo;
  env.RUSTUP_HOME = resolve(root, ".tools/rustup");
  env.PATH = `${cargo}/bin:${env.PATH}`;
}
const mode = process.argv[2] ?? "dev";
const args = [
  "run",
  "tauri",
  "--workspace",
  "@tastellar/app",
  "--",
  mode,
  ...(mode === "build" ? ["--bundles", "app"] : []),
];
const child = spawn("npm", args, { cwd: root, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
