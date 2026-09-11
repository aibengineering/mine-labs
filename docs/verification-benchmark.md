# Shared-world verification benchmark — 5 September 2026

Shared-world verification works, but **did not improve throughput at three bots
on this machine**. Across two measured batches per mode it took 4.8% more wall
time, using one JVM instead of three. Larger client counts remain unmeasured for
throughput; a separate [memory profile](verification-memory-profile.md) compares
3, 6 and 8 concurrent bots.

| Mode | Concurrent JVMs | Batch 1 | Batch 2 | Mean wall time | Outcomes across both batches |
| --- | ---: | ---: | ---: | ---: | --- |
| Isolated, three concurrent servers | 3 | 174.308 s | 178.172 s | 176.240 s | 4 passes, 2 failures |
| Shared, three concurrent clients | 1 | 185.386 s | 183.984 s | 184.685 s | 4 passes, 2 failures |

The measured speed-up factor is `176.240 / 184.685 = 0.954×`. This comparison
uses the existing parallel isolated mode as the baseline, not serial execution.
Both modes completed exactly the same three inputs per batch. Every batch passed
locations 1 and 3; location 2 burned to death. Its subsequent absence from the
declared radius settled that attempt without stopping the other clients.

## Workload and method

- Windows host, AMD Ryzen 7 9800X3D, 16 logical processors; vanilla Java 1.21.4.
- Mine AI `verification/obsidian/cast-obsidian.yaml`: collect ten obsidian,
  retain the water bucket, survive, and report completion.
- Seed `8675309`; starts `[8.5,64,-19.5]`, `[-807.5,114,800.5]`,
  `[1608.5,75,1600.5]`; horizontal radius 256. Surface heights were surveyed
  on a real generated world before authoring the manifests.
- Same client scripts, inventory, rules, goals, seed and locations in both modes.
  The retained resolved `scenario.json` files were compared for exact equality.
- Fresh worlds every batch; server binaries were already cached. Wall time
  includes world startup, client preparation, action execution, shutdown and
  evidence compaction. Per-client `runtimeMs` is retained separately.
- Run order: isolated, shared, shared, isolated. Batches ran sequentially, with
  no other test servers started by this task during the measured batches.
- An earlier qualification batch overlapped other checks and is excluded.

The first clean shared run's 35 periodic tick queries reported a mean of 2.73 ms
for their average tick times, with the highest sampled average at 11.9 ms against
a 50 ms target. Those samples do not indicate steady tick saturation at three
clients. Client logs show different navigation plans between runs; this benchmark
does not establish the cause of the timing difference or predict larger-N scaling.

Subsequent diamond qualification found the second location's player settled at
Y=105 rather than the surveyed Y=114. The diamond manifest now uses Y=105 and a
fresh-server handoff check confirmed 20 health. The obsidian manifest retains the
benchmarked Y=114 start, including its initial fall; its goal requires survival
but does not require 20 health. The measurements above compare that exact same
input across both modes, rather than claiming the initial fall was absent.

## Reproduce

From the Mine AI repository, the replacement manifest can be exercised with:

```bash
bun run scenarios:obsidian --jobs 3 --isolated
bun run scenarios:obsidian --jobs 3
```

Use `--repeat 2` for two fresh-world batches in one invocation. The diamond
counterpart is `bun run scenarios:progression`, and `scenarios:verify` runs both
verification manifests. Controlled fixtures use `run`; add `--repeat` for repetition.

## Evidence

Additional diamond qualification reached the full inventory goal at location 1
with 20 health in 468.895 seconds of client runtime. Location 2 exposed the spawn
height issue described above; its corrected handoff passed. Location 3 continued
excavating during dirt collection for more than eight minutes and the extra
qualification was interrupted. It has no terminal action verdict and is recorded
as cancelled, not as a failed goal. See the
[qualification notes](../.mine-labs/diamond-qualification/2026-09-05T00-44-05-057Z/qualification.json).

Validation: Mine Labs build/typecheck and 76 tests passed. Mine AI scenario
typechecking and the full `verify docs` command passed. All test server ports
were closed after qualification.

The local machine-readable comparison is
[`verification-benchmark.json`](../.mine-labs/verification-benchmark.json).
Each invocation retains resolved inputs, client logs and results under `runs/`;
shared server logs and tick samples are under `servers/`.

- [Isolated batch 1](../.mine-labs/benchmark-isolated/2026-09-05T00-29-13-922Z/verification.json)
- [Shared batch 1](../.mine-labs/benchmark-shared-clean/2026-09-05T00-32-35-979Z/verification.json)
- [Shared batch 2](../.mine-labs/benchmark-shared-repeat/2026-09-05T00-36-04-925Z/verification.json)
- [Isolated batch 2](../.mine-labs/benchmark-isolated-repeat/2026-09-05T00-39-35-228Z/verification.json)

Evidence directories are local and ignored by Git. This document retains the
measured figures when the generated evidence is unavailable in another checkout.
