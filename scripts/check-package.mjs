import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const files = new Set(packed[0].files.map(({ path }) => path));
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}
const required = ["package.json", "README.md", "LICENSE", ...manifest.pi.extensions.map((path) => path.replace(/^\.\//, "")), ...sourceFiles("extensions")];
const missing = [...new Set(required)].filter((path) => !files.has(path));
if (missing.length) {
  throw new Error(`Missing from npm package: ${missing.join(", ")}`);
}
console.log(`Package includes ${new Set(required).size} required files.`);
