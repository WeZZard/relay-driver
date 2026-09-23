# Execution environments

## Governing policies

Environment selection and lifecycle — remote-computer and VM allocation, task registry, and cleanup — are set by the deploying organization's own governing environment policy; this repository does not ship one. Image baselines are supplied externally too; read that image's own documentation before using it. The wrapper inherits the governing environment policy rather than creating another task registry or cleanup mechanism.

The image baseline registers Playwright, Chrome DevTools, and cua-driver. These are installed integrations, not the relay core's supported-backend list. Treat installed versions and launch-context permissions as runtime inputs; verify their actual contracts when preparing a session.

## Environment responsibilities

| Participant | Responsibility |
| --- | --- |
| Controlling host | Assign or inherit task identity, coordinate the existing transfer channel, validate the delivered package, and retain durable evidence. |
| Remote computer or VM | Execute input and capture in the assigned desktop context, timestamp local events, and retain the package until host acceptance. |
| Viewer environment | Open the accepted package without depending on the original machine, its processes, or its credentials. |

The recorded application uses the installation and launch path required by the governing environment policy. Permission checks must cover the actual execution and capture context.

## Display ownership

The tested UI and any companion application needed to explain it must appear on the recorded display. The governing environment policy should prefer headless browsers only when they meet the task's needs; a headless run can supply separate test evidence but cannot show its browser interaction in a whole-desktop recording.

Keep display configuration stable for the recording.

## Task resource budgets

[D19](../decisions.md#execution) requires task storage and per-execution output limits, explicit bounds on Relay buffers, and shutdown capacity protected from ordinary work. Defaults derive from the inherited deadline and measured recorder profile; overrides stay within the task budget. Scripts do not estimate resources per action.

### Capacity model

Use bytes for storage, bytes/second for rates, and seconds for durations.

```text
D_work = r_video * T + O + J + A + X
R_stop = r_tail * (delta_poll + t_stop) + S_finalize + S_diagnostic + S_burst
B_work = min(B_task - U0, F0 - H) - R_stop

Admit the planned work only when D_work <= B_work.
```

`D_work` estimates additional working storage: conservative encoded-video rate `r_video` over remaining task duration `T`, plus output `O`, journal `J`, supporting artifacts `A`, and peak extra export/derivative scratch `X` while originals remain retained. Account separately for host capacity when export work runs there.

`R_stop` reserves additional shutdown capacity: concurrent tail-write rate `r_tail` during maximum intended monitoring interval `delta_poll` and shutdown allowance `t_stop`, plus finalization metadata `S_finalize`, bounded diagnostics `S_diagnostic`, and buffered bursts `S_burst` not already counted in the rate. Avoid overlap between ordinary and stop allowances.

`B_work` is the smaller of task-budget headroom and available-volume headroom, less the stop allowance. `B_task` is total task storage budget, `U0` is already-accounted task use, `F0` is volume capacity currently available to the task user, and `H` is the environment's retained free-space floor.

Profile the actual display size, frame rate, codec, and quality during representative motion, startup, and finalization. An idle sample or average target bitrate is not a hard upper bound. Reuse a profile only while conditions match. RAM planning uses recorder/tool working-set measurements and bounded queues; virtual address-space size is not a physical-memory requirement. Recorder profiles, shutdown demand, monitoring cadence, and numeric margins are `(to verify)` in the assigned environment.

### Live accounting and detection

A remote supervisor survives SSH disconnects and runs outside the tool script's event loop. It checks resource-health freshness before input admission and continuously supervises capture, resource pressure, and the monotonic task deadline.

| Resource | Measurement and stop condition |
| --- | --- |
| Per-execution output | Atomically count committed and reserved bytes before accepting a chunk; refuse a chunk that would exceed its execution cap. |
| Task storage | Count committed and reserved writes; reconcile independently written files without double-counting. Stop before remaining budget enters `R_stop`. |
| Volume capacity | Sample space available to the task user on every written volume and account for pending unallocated writes. Stop before headroom enters `H + R_stop`. |
| Relay buffers | Reserve bytes against per-queue and aggregate caps before enqueueing. Apply bounded backpressure or stop; do not grow memory with disconnected output. |
| Tools and recorder | Observe working sets, memory pressure, recording progress, backlog, and timing continuity. Stop affected work on configured pressure/health thresholds or stale supervision. |
| Task lifetime | Enforce the inherited deadline with a monotonic clock independently of host connectivity. |

Retain separate diagnostics for the limit reached, observed usage, configured threshold, and resulting refusal/stop. Close input admission first, stop affected owned work, and finalize available capture within its allowance. Catch actual write/quota failures in addition to predictive checks. Output truncation and damaged media remain explicit; never overwrite original evidence to recover capacity. Apply the [damaged-artifact acceptance contract](artifact-format.md#host-acceptance) when finalization fails.

Byte accounting strictly bounds Relay-controlled queues and output. Monitoring an external process does not impose a hard memory or filesystem quota, and a budget allowance does not reserve physical disk against unrelated writers. Use stronger controls supplied by the governing environment when available and identify the enforcement actually established. Guaranteed finalization requires demonstrated reservation and shutdown bounds; an estimate alone cannot establish it.

[Python filesystem statistics](https://docs.python.org/3/library/os.html#os.statvfs_result) and [Node filesystem statistics](https://nodejs.org/api/fs.html#statfsbavail) expose currently available volume capacity. Node's [stream buffering contract](https://nodejs.org/api/stream.html#buffering) distinguishes backpressure thresholds from strict memory limits. Apply explicit accounting alongside those primitives.

## Authority and credentials

The wrapper consumes the execution authority granted by the environment workflow. Credential custody remains with the governing environment and image policies; the wrapper introduces no independent secret store or credential-transfer channel. Record the relevant permission result and context without exporting credential values into the review package.

The [record-and-export runbook](../ops/record-and-export.md) applies this environment design. Reboot, uninstall, unregister, and VM destruction remain responsibilities of the governing environment workflow after accepted export.
