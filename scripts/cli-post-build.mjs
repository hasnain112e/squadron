// Cross-platform stand-in for the chmod / mkdir -p / cp steps that followed tsc; run with packages/cli as cwd.
import { chmodSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

function copyByExtension(fromDir, toDir, extension) {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(fromDir)) {
    if (name.endsWith(extension)) copyFileSync(join(fromDir, name), join(toDir, name));
  }
}

chmodSync("dist/bin-wrapper.js", 0o755);
copyByExtension("src/schemas", "dist/schemas", ".json");
copyByExtension("src/lib/scope-templates", "dist/lib/scope-templates", ".md");
copyFileSync("../../LICENSE", "LICENSE");
