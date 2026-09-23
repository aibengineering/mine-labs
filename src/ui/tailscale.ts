/**
 * Find the address Tailscale remote mode serves the lab on.
 *
 * Remote mode deliberately depends on Tailscale rather than taking an arbitrary
 * bind address: the control API has no login of its own, so the tailnet is the
 * access control. Binding to this machine's tailnet address keeps the lab off
 * every other interface, including the local network.
 */
import { spawnSync } from "node:child_process";

export function tailscaleAddress(run = spawnSync): string {
  const result = run("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) {
    throw new Error(`Tailscale remote mode needs the tailscale CLI on PATH: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim() || `exit ${result.status ?? result.signal}`;
    throw new Error(`Tailscale remote mode could not read this machine's tailnet address (${detail}). Is Tailscale up?`);
  }
  const address = String(result.stdout ?? "").split(/\s+/u).find(line => /^\d{1,3}(\.\d{1,3}){3}$/u.test(line));
  if (!address) throw new Error("Tailscale remote mode found no IPv4 tailnet address; run `tailscale ip -4` to check.");
  return address;
}
