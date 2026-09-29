// Copies the Squadron swarm visualizer (a scripted concept simulation) to your Downloads folder.
// Usage: node scripts/demo-simulation.mjs [--out <directory>]
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "swarm-visualizer.html");
const flag = process.argv.indexOf("--out");
if (flag !== -1 && !process.argv[flag + 1]) {
  console.error("refused: --out needs a directory");
  process.exit(1);
}
const outDir = flag === -1 ? join(homedir(), "Downloads") : resolve(process.argv[flag + 1]);
const dest = join(outDir, "squadron-visualizer.html");

mkdirSync(outDir, { recursive: true });
copyFileSync(source, dest);
console.log(`Copied ${statSync(dest).size} bytes to ${dest}`);
console.log("Open it in a browser. It is a scripted concept simulation, not live output.");
