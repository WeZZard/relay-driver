# Capture and timing

## Snapshot evidence (SNAP-01/02/03)

Relay Driver's built-in evidence is the dispatch-time snapshot pair
(D20–D24): a before-snapshot immediately before each input event dispatches
and an after-snapshot exactly the agent-supplied interval after dispatch
completion. Capture readiness is screenshot capability — probing
`get_desktop_state` on the cua-driver path — never an active recording
(D24). Video belongs to applications (D24): an application recording a
trajectory may record continuously and attach the segments as application
attachments, which Relay verifies byte-wise without interpreting.

The agent-supplied `afterIntervalMs` is authoritative (D20): the runtime
waits exactly that long from dispatch completion. There is no settle
detection and no default; a request without an interval is refused before
dispatch. Snapshots are named `<journal-seq>-<ISO-8601Z>-<role>-<identity>.png`
(D23), hashed at capture, and journaled with declared interval plus actual
capture-start/complete times.

## Recorder reuse (application-level video)

Select a capture integration by its evidence contract independently of the backend performing the actions.

The documented cua-driver recording interface provides per-action arguments and results, before/after accessibility state and screenshots, and optional full-display video. Its documented macOS video path uses ScreenCaptureKit. Reuse these artifacts where their contracts satisfy the trajectory requirements. Relay Driver itself no longer consumes the recording interface (D24); applications that attach video reference these contracts directly.

The documented ISO-8601 action timestamps do not by themselves establish exact media alignment. Verify frame/event correlation and recording ownership in the actual execution context before relying on the recorder.

## Clock correlation

The execution environment owns input timing and capture timing. Retain the controlling host's request/response times and UTC only as separate audit information. A VM and its host must not be assumed to share a monotonic clock.

Apply the same clock correlation to SSH-submitted operations and uploaded-script actions. Record the boundary actually observed: SDK invocation times establish an operation interval; input-dispatch timestamps require evidence from that dispatch path. Neither SSH send time nor upload completion substitutes for either interval. Loss of a completion record retains an open interval and an uncertain outcome.

- Preserve the input event clock and captured frame presentation timestamps.
- Retain a verified mapping into the media timestamps written to each segment.
- Normalize playback to the first recorded frame.
- Preserve rational timestamps internally; decimal seconds are a presentation format.
- Read frame timestamps rather than using capture-callback arrival time.
- Do not infer time from a nominal frame rate.

Verify the clock mapping against the recorder and encoded output before accepting it as precise.

## Observation precision

Return recorded-frame identifiers and actual media timestamps when supplying visual evidence to the agent. A separately captured image, accessibility inspection, or file assertion must retain its own source and timing; it is not automatically a frame of the recording.

Keep uncertainty intervals when observations are sparse. A replay or closer frame inspection may narrow the interval, but the original observations remain intact. [Timeline semantics](../arch/timeline.md) define what those intervals mean.

## Playback synchronization

Use the presented video's media timeline to update the explanatory UI. Browser video-frame callbacks expose a media timestamp, but browser seeking is not a guarantee of exact-frame selection. Provide verified still frames for precise review checkpoints and keep a source mapping for each playback derivative.

## References

- [Cua trajectory recording](https://cua.ai/docs/how-to-guides/driver/record-and-render-a-trajectory) describes action artifacts and optional display capture.
- [ScreenCaptureKit synchronization clock](https://developer.apple.com/documentation/screencapturekit/scstream/synchronizationclock) describes the captured sample timebase.
- [Core Media clocks](https://developer.apple.com/documentation/coremedia/cmclock-api) describes conversion and synchronization mechanisms.
- [Video frame callbacks](https://wicg.github.io/video-rvfc/) defines the browser's frame metadata.
- [Browser timing and seeking limits](https://web.dev/articles/requestvideoframecallback-rvfc) explains the precision limits of the video element.
