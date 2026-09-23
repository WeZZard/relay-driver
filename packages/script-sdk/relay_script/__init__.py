"""Script-side Relay SDK for Python scripts (SCRIPT-01).

A deployed Python script wraps each of its individual tool calls with
Relay.recorded_call(). Every call is admitted through the runtime's
admission engine via a per-call subprocess (bin/script-call.mjs), gets its
own durable action record and journal receipt, and cites the script
execution as its parent identity — one receipt per call, never one receipt
for the whole script.
"""
import json
import subprocess
from typing import Any, Callable, Optional

DEFAULT_RUNNER = [
    "node",
    "/var/tmp/2026-09-09-21-51-38-Z-relay-driver-stage1/packages/script-sdk/bin/script-call.mjs",
]


class AdmissionRefused(Exception):
    """Admission refused: the callable was never invoked, no input dispatched."""


class Relay:
    def __init__(
        self,
        state_dir: str,
        parent_execution_id: str,
        runner: Optional[list] = None,
        session_id: Optional[str] = None,
        attempt_id: Optional[str] = None,
    ) -> None:
        self.state_dir = state_dir
        self.parent_execution_id = parent_execution_id
        self.runner = runner or DEFAULT_RUNNER
        self.session_id = session_id
        self.attempt_id = attempt_id
        self._current_step: Optional[dict] = None

    def step(self, description: dict, body: Callable[["Relay"], Any]) -> Any:
        """Grouped narrative step: describe once; each inner call is recorded."""
        self._current_step = description
        try:
            return body(self)
        finally:
            self._current_step = None

    def recorded_call(
        self,
        argv: list,
        title: Optional[str] = None,
        input_mode: Optional[str] = None,
        cwd: Optional[str] = None,
        observe_recording: bool = True,
    ) -> dict:
        """Run one argv as one individually recorded call. Returns the receipt."""
        request: dict[str, Any] = {
            "stateDir": self.state_dir,
            "parentExecutionId": self.parent_execution_id,
            "sessionId": self.session_id,
            "attemptId": self.attempt_id,
            "observeRecording": observe_recording,
            "argv": argv,
        }
        step = self._current_step or {}
        request["stepId"] = step.get("id")
        request["title"] = title or step.get("title") or "python recorded call"
        request["inputMode"] = input_mode or step.get("inputMode")
        if cwd:
            request["cwd"] = cwd
        proc = subprocess.run(self.runner, input=json.dumps(request), capture_output=True, text=True)
        try:
            receipt = json.loads(proc.stdout)
        except json.JSONDecodeError as err:
            raise RuntimeError(f"script-call runner produced no receipt: {proc.stderr[-400:]}") from err
        if receipt.get("refused"):
            raise AdmissionRefused(receipt.get("diagnostic", "admission refused"))
        if receipt.get("error"):
            raise RuntimeError(receipt["error"])
        return receipt
