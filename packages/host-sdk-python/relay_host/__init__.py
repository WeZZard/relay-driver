"""Relay Driver Python Host SDK (D12).

Python parity for the host side: open a relay, start a session over SSH,
submit framed executions (exec, uploaded script, streamed code), persist
durable submission identities before transmission (D14), inspect outcomes,
and enumerate executions. The framed protocol and its outcome semantics are
identical to the TypeScript host SDK: one JSON request per `ssh` invocation
of the remote receiver, one JSON response on the last stdout line.

Transport loss maps to an uncertain outcome (never a silent failure); the
submission store keeps every execution inspectable after a crash.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

DEFAULT_RUNNER = "/opt/homebrew/bin/node /var/tmp/relay-driver-runtime/receive.js"


def _new_id(prefix: str) -> str:
    """Time-ordered identifier mirroring the TS SDK's allocateId/formatId."""
    millis = time.time_ns() // 1_000_000
    hex12 = uuid.uuid4().hex[:12]
    return f"{prefix}-0{millis:011x}{hex12}"


@dataclass
class Outcome:
    kind: str  # "completed" | "uncertain" | "refused"
    diagnostic: Optional[str] = None
    raw: dict = field(default_factory=dict)


@dataclass
class ExecResult:
    execution_id: str
    outcome: Outcome


class SubmissionStore:
    """Durable execution submissions saved BEFORE transmission (D14)."""

    def __init__(self, root: str | os.PathLike) -> None:
        self.root = Path(root)
        (self.root / "sessions").mkdir(parents=True, exist_ok=True)

    def save(self, submission: dict) -> None:
        session_dir = self.root / "sessions" / submission["sessionId"]
        session_dir.mkdir(parents=True, exist_ok=True)
        path = session_dir / f"{submission['executionId']}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(submission, indent=2))
        os.replace(tmp, path)

    def list_executions(self, session_id: str) -> list[dict]:
        session_dir = self.root / "sessions" / session_id
        if not session_dir.exists():
            return []
        out = []
        for path in sorted(session_dir.glob("execution-*.json")):
            out.append(json.loads(path.read_text()))
        return out


class SshTransport:
    """The framed SSH transport: one receiver invocation per request."""

    def __init__(
        self,
        target: str,
        remote_runner: str = DEFAULT_RUNNER,
        ssh_args: Optional[list[str]] = None,
        command_runner: Optional[Callable[[list[str], Optional[str]], tuple[str, str, int]]] = None,
    ) -> None:
        self.target = target
        self.remote_runner = remote_runner
        self.ssh_args = ssh_args or []
        # Injectable for tests; defaults to spawning the real ssh process.
        self._command_runner = command_runner or self._spawn_ssh

    def _spawn_ssh(self, argv: list[str], input_text: Optional[str]) -> tuple[str, str, int]:
        proc = subprocess.run(
            ["ssh", *self.ssh_args, self.target, "--", *argv],
            input=input_text,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return proc.stdout, proc.stderr, proc.returncode

    def send(self, request: dict) -> dict:
        argv = self.remote_runner.split(" ")
        if argv[0] == "node":
            argv[0] = "/opt/homebrew/bin/node"
        stdout, stderr, code = self._command_runner(argv, json.dumps(request))
        if code != 0 and not stdout.strip():
            return {
                "executionId": request["executionId"],
                "outcome": {"kind": "uncertain", "diagnostic": f"ssh exit {code}: {stderr.strip()[:500]}"},
            }
        last_line = stdout.strip().split("\n")[-1]
        response = json.loads(last_line)
        if response.get("executionId") != request["executionId"]:
            return {
                "executionId": request["executionId"],
                "outcome": {"kind": "uncertain", "diagnostic": "response identity mismatch"},
            }
        return response

    def upload(self, local_path: str, remote_path: str) -> dict:
        parent = os.path.dirname(remote_path)
        stdout, stderr, code = self._command_runner(["/bin/mkdir", "-p", parent], None)
        if code != 0:
            raise RuntimeError(f"mkdir failed: {stderr.strip()[:300]}")
        proc = subprocess.run(
            ["scp", "-q", *self.ssh_args, local_path, f"{self.target}:{remote_path}"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"scp failed: {proc.stderr.strip()[:300]}")
        script_id = _new_id("script")
        return {"scriptId": script_id, "path": remote_path}


class Relay:
    """Entry point: Relay.open(store_root), use_ssh(...), start(...)."""

    def __init__(self, store_root: str | os.PathLike) -> None:
        self.store = SubmissionStore(store_root)
        self._target: Optional[str] = None
        self._transport: Optional[SshTransport] = None

    @staticmethod
    def open(store_root: str | os.PathLike) -> "Relay":
        return Relay(store_root)

    def use_ssh(self, target: str, remote_runner: str = DEFAULT_RUNNER, ssh_args: Optional[list[str]] = None) -> "Relay":
        self._target = target
        self._transport = SshTransport(target, remote_runner, ssh_args)
        return self

    def use_transport(self, transport: SshTransport) -> "Relay":
        self._transport = transport
        return self

    def start(self, target: Optional[str] = None, task_id: str = "task-python") -> "Session":
        transport = self._transport
        if transport is None:
            raise RuntimeError("no transport configured; call use_ssh() first")
        session_id = _new_id("session")
        return Session(session_id, transport, self.store)


class Session:
    def __init__(self, session_id: str, transport: SshTransport, store: SubmissionStore) -> None:
        self.session_id = session_id
        self._transport = transport
        self._store = store

    def exec(
        self,
        argv: list[str],
        step_id: Optional[str] = None,
        title: Optional[str] = None,
        input_mode: Optional[str] = None,
        cwd: Optional[str] = None,
        snapshots: Optional[dict] = None,
    ) -> ExecResult:
        """Run argv remotely. ``snapshots`` carries the snapshot-evidence
        contract (SNAP-02/03): ``{"afterIntervalMs": ms}`` for single events
        or ``{"group": {"groupId": id, "phase": "first"|"member"|"last",
        "afterIntervalMs": ms}}`` for sender-declared coalescing groups."""

        execution_id = _new_id("execution")
        submission = {
            "executionId": execution_id,
            "sessionId": self.session_id,
            "argv": argv,
            "submittedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "state": "pending",
        }
        self._store.save(submission)
        request = {
            "kind": "exec",
            "executionId": execution_id,
            "sessionId": self.session_id,
            "argv": argv,
            "step": {"id": step_id, "title": title, "inputMode": input_mode}
            if step_id or title
            else None,
        }
        if cwd:
            request["cwd"] = cwd
        if snapshots:
            request["snapshots"] = snapshots
        response = self._transport.send(request)
        outcome = response.get("outcome", {})
        state = "completed" if outcome.get("kind") == "completed" else "uncertain"
        self._store.save({**submission, "state": state, "outcome": outcome})
        return ExecResult(execution_id, Outcome(
            kind=outcome.get("kind", "uncertain"),
            diagnostic=outcome.get("diagnostic"),
            raw=outcome,
        ))

    def run_code(
        self,
        code: str,
        language: str,
        step_id: Optional[str] = None,
        title: Optional[str] = None,
        snapshots: Optional[dict] = None,
    ) -> ExecResult:
        """Streamed-code submission: hash declared before transmission."""
        code_sha256 = hashlib.sha256(code.encode("utf-8")).hexdigest()
        execution_id = _new_id("execution")
        submission = {
            "executionId": execution_id,
            "sessionId": self.session_id,
            "argv": [language, "<streamed-code>"],
            "submittedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "state": "pending",
            "script": {"scriptId": f"code-{execution_id}", "remotePath": "<streamed>", "language": language, "sha256": code_sha256},
        }
        self._store.save(submission)
        request = {
            "kind": "code",
            "executionId": execution_id,
            "sessionId": self.session_id,
            "language": language,
            "code": code,
            "codeSha256": code_sha256,
            "step": {"id": step_id, "title": title} if step_id or title else None,
        }
        if snapshots:
            request["snapshots"] = snapshots
        response = self._transport.send(request)
        outcome = response.get("outcome", {})
        state = "completed" if outcome.get("kind") == "completed" else "uncertain"
        self._store.save({**submission, "state": state, "outcome": outcome})
        return ExecResult(execution_id, Outcome(
            kind=outcome.get("kind", "uncertain"),
            diagnostic=outcome.get("diagnostic"),
            raw=outcome,
        ))

    def upload_and_run(
        self,
        local_path: str,
        remote_path: str,
        language: str,
        step_id: Optional[str] = None,
        title: Optional[str] = None,
        snapshots: Optional[dict] = None,
    ) -> ExecResult:
        upload = self._transport.upload(local_path, remote_path)
        with open(local_path, "rb") as f:
            sha256 = hashlib.sha256(f.read()).hexdigest()
        execution_id = _new_id("execution")
        submission = {
            "executionId": execution_id,
            "sessionId": self.session_id,
            "argv": [language, remote_path],
            "submittedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "state": "pending",
            "script": {"scriptId": upload["scriptId"], "remotePath": remote_path, "language": language, "sha256": sha256},
        }
        self._store.save(submission)
        request = {
            "kind": "script",
            "executionId": execution_id,
            "sessionId": self.session_id,
            "remotePath": remote_path,
            "language": language,
            "scriptId": upload["scriptId"],
            "scriptSha256": sha256,
            "step": {"id": step_id, "title": title} if step_id or title else None,
        }
        if snapshots:
            request["snapshots"] = snapshots
        response = self._transport.send(request)
        outcome = response.get("outcome", {})
        state = "completed" if outcome.get("kind") == "completed" else "uncertain"
        self._store.save({**submission, "state": state, "outcome": outcome})
        return ExecResult(execution_id, Outcome(
            kind=outcome.get("kind", "uncertain"),
            diagnostic=outcome.get("diagnostic"),
            raw=outcome,
        ))

    def executions(self) -> list[dict]:
        return self._store.list_executions(self.session_id)
