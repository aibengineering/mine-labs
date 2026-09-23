/**
 * Hand out a free game/RCON port pair to each server.
 *
 * Parallel trials mean several Minecraft servers alive at once, and a port
 * collision surfaces as a confusing server-side boot failure rather than
 * anything that names ports. The subtlety is that a port cannot actually be
 * reserved on behalf of a Java process that has not started yet, so this closes
 * the race it can close: an in-process lease set means two workers in the same
 * Mine Labs run never select the same pair, even when their probes overlap.
 *
 * Availability is probed by connecting rather than binding, because Node sets
 * SO_REUSEADDR on Windows, where a bind probe succeeds against a port something
 * is actively listening on.
 */

import net from "node:net";

export interface PortPairLease {
  gamePort: number;
  rconPort: number;
  release(): void;
}

// A connect probe cannot reserve a port for the later Java process. This set
// closes the important race inside one Mine Labs process: parallel workers can
// no longer observe and select the same free game/RCON pair.
const leasedPorts = new Set<number>();

/**
 * A port is busy if something accepts connections on it. We probe by
 * connecting rather than binding: Node sets SO_REUSEADDR on Windows, which
 * makes a bind-probe succeed against a port that is actively listening.
 */
function isFree(port: number, host: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const client = net.connect({ port, host });
  client.setTimeout(500);
  client.once("connect", () => {
    client.destroy();
    resolve(false);
  });
  client.once("timeout", () => {
    client.destroy();
    resolve(false);
  });
  client.once("error", () => resolve(true));
  return promise;
}

export async function reserveFreePortPair(preferred: number, host = "127.0.0.1"): Promise<PortPairLease> {
  for (let p = preferred; p < preferred + 200; p++) {
    const rconPort = p + 1;
    if (leasedPorts.has(p) || leasedPorts.has(rconPort)) continue;
    if (!(await isFree(p, host)) || !(await isFree(rconPort, host))) continue;
    // Another asynchronous claimant may have leased the pair while these
    // connect probes were in flight.
    if (leasedPorts.has(p) || leasedPorts.has(rconPort)) continue;

    leasedPorts.add(p);
    leasedPorts.add(rconPort);
    let released = false;
    return {
      gamePort: p,
      rconPort,
      release() {
        if (released) return;
        released = true;
        leasedPorts.delete(p);
        leasedPorts.delete(rconPort);
      },
    };
  }
  throw new Error(`no free game/RCON port pair found starting from ${preferred}`);
}
