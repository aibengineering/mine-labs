import assert from "node:assert/strict";
import test from "node:test";
import { reserveFreePortPair, type PortPairLease } from "./ports.js";

test("parallel port claims receive disjoint game and RCON pairs", async () => {
  const leases: PortPairLease[] = [];
  try {
    leases.push(...await Promise.all([
      reserveFreePortPair(28_000),
      reserveFreePortPair(28_000),
      reserveFreePortPair(28_000),
    ]));

    const ports = leases.flatMap(({ gamePort, rconPort }) => [gamePort, rconPort]);
    assert.equal(new Set(ports).size, ports.length);
    for (const lease of leases) assert.equal(lease.rconPort, lease.gamePort + 1);
  } finally {
    for (const lease of leases) lease.release();
  }
});
