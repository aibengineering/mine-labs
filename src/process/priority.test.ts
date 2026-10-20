import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import test from "node:test";

const BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL;
const IDLE = constants.priority.PRIORITY_LOW;
const module = new URL("./priority.ts", import.meta.url).href;

/**
 * Runs `body` in a fresh Bun process, so lowering a priority never touches the
 * test runner, and returns the numbers it prints.
 */
function inChild(body: string): number[] {
  const script = `import { yieldToForeground } from ${JSON.stringify(module)};
import { getPriority, setPriority } from "node:os";
import { spawnSync } from "node:child_process";
${body}`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\s+/u).map(Number);
}

test("a session drops to below normal, and the servers and clients it starts inherit it", () => {
  const [own, child] = inChild(`
yieldToForeground();
const child = spawnSync(process.execPath, ["-e", "console.log(require('node:os').getPriority())"], { encoding: "utf8" });
console.log(getPriority(), child.stdout.trim());`);
  assert.equal(own, BELOW_NORMAL);
  assert.equal(child, BELOW_NORMAL);
});

test("a session already running lower keeps its priority", () => {
  const [own] = inChild(`
setPriority(${IDLE});
yieldToForeground();
console.log(getPriority());`);
  assert.equal(own, IDLE);
});
