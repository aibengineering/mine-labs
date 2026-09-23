import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import test from "node:test";
import { tailscaleAddress } from "./tailscale.js";

const reply = (value: Partial<ReturnType<typeof spawnSync>>) => (() => ({
  pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...value,
})) as unknown as typeof spawnSync;

test("Tailscale remote mode serves the machine's IPv4 tailnet address", () => {
  assert.equal(tailscaleAddress(reply({ stdout: "100.101.102.103\n" })), "100.101.102.103");
});

test("Tailscale remote mode explains a missing CLI, a stopped tailnet, and no IPv4 address", () => {
  assert.throws(() => tailscaleAddress(reply({ error: new Error("spawnSync tailscale ENOENT") })), /tailscale CLI on PATH/u);
  assert.throws(() => tailscaleAddress(reply({ status: 1, stderr: "Tailscale is stopped." })), /Tailscale is stopped\..*Is Tailscale up/u);
  assert.throws(() => tailscaleAddress(reply({ stdout: "\n" })), /no IPv4 tailnet address/u);
});
