"""Python host SDK tests (D12): framed protocol parity with the TS SDK and
durable-before-submit submission semantics (D14)."""
import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from relay_host import Relay, SshTransport


class FakeRunner:
    """Replays canned responses; records received requests."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.received = []
        self.fail_next = None  # (code, stderr) to simulate ssh death

    def __call__(self, argv, input_text):
        self.received.append(json.loads(input_text))
        if self.fail_next is not None:
            code, stderr = self.fail_next
            self.fail_next = None
            return "", stderr, code
        return self.responses.pop(0), "", 0


class RelayHostTest(unittest.TestCase):
    def _relay(self, responses, fake=None):
        fake = fake or FakeRunner(responses)
        relay = Relay.open(tempfile.mkdtemp())
        transport = SshTransport("wezzard@host", command_runner=fake)
        session = relay.use_transport(transport).start(task_id="task-py")
        return session, fake

    def test_exec_framing_and_durable_submissions(self):
        received = []

        def echo(argv, input_text):
            req = json.loads(input_text)
            received.append(req)
            return json.dumps({"executionId": req["executionId"], "outcome": {"kind": "completed", "exitStatus": {"code": 0, "signal": None}}}), "", 0

        relay = Relay.open(tempfile.mkdtemp())
        session = relay.use_transport(SshTransport("t", command_runner=echo)).start()
        result = session.exec(["/bin/echo", "hi"], step_id="s1", title="echo step")
        self.assertEqual(result.outcome.kind, "completed")
        req = received[-1]
        self.assertEqual(req["kind"], "exec")
        self.assertEqual(req["step"]["id"], "s1")
        self.assertEqual(req["argv"], ["/bin/echo", "hi"])
        subs = session.executions()
        self.assertEqual(len(subs), 1)
        self.assertEqual(subs[0]["state"], "completed")
        self.assertEqual(subs[0]["argv"], ["/bin/echo", "hi"])

    def test_transport_loss_is_uncertain_and_submission_inspectable(self):
        received = []

        def dying(argv, input_text):
            received.append(json.loads(input_text))
            return "", "connection closed", 255

        relay = Relay.open(tempfile.mkdtemp())
        session = relay.use_transport(SshTransport("t", command_runner=dying)).start()
        result = session.exec(["/bin/true"])
        self.assertEqual(result.outcome.kind, "uncertain")
        self.assertIn("ssh exit 255", result.outcome.diagnostic)
        subs = session.executions()
        self.assertEqual(len(subs), 1)
        self.assertEqual(subs[0]["state"], "uncertain")
        self.assertEqual(subs[0]["argv"], ["/bin/true"])

    def test_identity_mismatch_is_uncertain(self):
        def mismatched(argv, input_text):
            return json.dumps({"executionId": "someone-else", "outcome": {"kind": "completed"}}), "", 0

        relay = Relay.open(tempfile.mkdtemp())
        session = relay.use_transport(SshTransport("t", command_runner=mismatched)).start()
        result = session.exec(["/bin/true"])
        self.assertEqual(result.outcome.kind, "uncertain")
        self.assertEqual(result.outcome.diagnostic, "response identity mismatch")

    def test_run_code_declares_hash_before_transmission(self):
        received = []

        def echo(argv, input_text):
            req = json.loads(input_text)
            received.append(req)
            return json.dumps({"executionId": req["executionId"], "outcome": {"kind": "completed", "exitStatus": {"code": 0, "signal": None}}}), "", 0

        relay = Relay.open(tempfile.mkdtemp())
        session = relay.use_transport(SshTransport("t", command_runner=echo)).start()
        code = 'print("py-host-ok")'
        result = session.run_code(code, "python", step_id="rc1", title="run code")
        self.assertEqual(result.outcome.kind, "completed")
        import hashlib
        expected = hashlib.sha256(code.encode()).hexdigest()
        req = received[-1]
        self.assertEqual(req["kind"], "code")
        self.assertEqual(req["codeSha256"], expected)
        self.assertEqual(req["code"], code)
        subs = session.executions()
        self.assertEqual(subs[0]["script"]["sha256"], expected)
        self.assertEqual(subs[0]["script"]["remotePath"], "<streamed>")

    def test_durable_submission_precedes_transmission(self):
        received = []
        saved_at_send = {}

        def slow_fail(argv, input_text):
            received.append(json.loads(input_text))
            # Simulate crash after submission store write but before response.
            return "", "", 255

        relay = Relay.open(tempfile.mkdtemp())
        session = relay.use_transport(SshTransport("t", command_runner=slow_fail)).start()
        session.exec(["/bin/true"])
        # Even though the transport died, the submission exists on disk with
        # the original argv — the recovery identity (D14).
        self.assertEqual(len(received), 1)
        subs = session.executions()
        self.assertEqual(subs[0]["state"], "uncertain")
        self.assertEqual(subs[0]["argv"], ["/bin/true"])
        self.assertEqual(subs[0]["executionId"], received[0]["executionId"])


if __name__ == "__main__":
    unittest.main()


class SnapshotsPassthroughTest(unittest.TestCase):
    """SNAP-02/03 parity: the Python SDK carries snapshot params on framed
    requests exactly as the TS host SDK does (gap #7)."""

    def _session(self, received):
        def echo(argv, input_text):
            if input_text is None:
                # transport.upload's mkdir pre-step; no framed request here.
                return "", "", 0
            req = json.loads(input_text)
            received.append(req)
            return json.dumps({"executionId": req["executionId"], "outcome": {"kind": "completed", "exitStatus": {"code": 0, "signal": None}}}), "", 0
        relay = Relay.open(tempfile.mkdtemp())
        return relay.use_transport(SshTransport("t", command_runner=echo)).start()

    def test_exec_single_interval(self):
        received = []
        session = self._session(received)
        session.exec(["/bin/echo", "hi"], snapshots={"afterIntervalMs": 700})
        self.assertEqual(received[-1]["snapshots"], {"afterIntervalMs": 700})

    def test_exec_group_form(self):
        received = []
        session = self._session(received)
        session.exec(["/bin/echo", "hi"], snapshots={
            "group": {"groupId": "grp-hello", "phase": "last", "afterIntervalMs": 900},
        })
        self.assertEqual(received[-1]["snapshots"], {
            "group": {"groupId": "grp-hello", "phase": "last", "afterIntervalMs": 900},
        })

    def test_no_snapshots_omits_the_field(self):
        received = []
        session = self._session(received)
        session.exec(["/bin/echo", "hi"])
        self.assertNotIn("snapshots", received[-1])

    def test_run_code_and_upload_and_run_carry_snapshots(self):
        received = []
        session = self._session(received)
        session.run_code("print(1)", "python", snapshots={"afterIntervalMs": 250})
        self.assertEqual(received[-1]["kind"], "code")
        self.assertEqual(received[-1]["snapshots"], {"afterIntervalMs": 250})
        # upload_and_run's byte transfer uses real scp; stub the upload step
        # (the framed-request shape is what is under test here).
        with unittest.mock.patch.object(
            SshTransport, "upload",
            lambda self, local_path, remote_path: {"scriptId": "script-stub", "path": remote_path},
        ):
            with tempfile.TemporaryDirectory() as d:
                script = Path(d) / "s.py"
                script.write_text("print(2)\n")
                session.upload_and_run(str(script), "/tmp/snap-s.py", "python", snapshots={"afterIntervalMs": 120})
        self.assertEqual(received[-1]["kind"], "script")
        self.assertEqual(received[-1]["snapshots"], {"afterIntervalMs": 120})
