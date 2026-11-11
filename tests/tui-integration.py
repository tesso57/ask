"""Exercise the actual Pi terminal UI with a local fake OpenAI-compatible model."""
import json
import os
import pty
import select
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def exercise(mode, response, expected, *, choose_option=False):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            base = {"id": "test", "object": "chat.completion.chunk", "created": 1, "model": "test-model"}
            if len(requests) == 1:
                args = json.dumps({"question": "Pick one", "options": ["A", "B"], "mode": mode})
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "ask_user", "arguments": args}}]}
                reason = "tool_calls"
            else:
                delta, reason = {"role": "assistant", "content": "OK"}, "stop"
            for event in [
                {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": reason}]},
                "[DONE]",
            ]:
                payload = event if isinstance(event, str) else json.dumps(event)
                self.wfile.write(("data: " + payload + "\n\n").encode())
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    directory = tempfile.mkdtemp(prefix="pi-ask-tui-")
    master, slave = pty.openpty()
    env = {**os.environ, "PI_CODING_AGENT_DIR": directory, "PI_OFFLINE": "1", "ASK_FAKE_PORT": str(server.server_port), "TERM": "xterm-256color", "NO_COLOR": "1"}
    process = subprocess.Popen(
        ["pi", "--no-session", "--no-skills", "--provider", "ask-test", "--model", "test-model", "-e", str(Path(__file__).parent / "fixtures" / "pi-harness.ts")],
        stdin=slave, stdout=slave, stderr=slave, env=env,
    )
    os.close(slave)
    buffer = b""

    def wait_for(needle):
        nonlocal buffer
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if needle in buffer:
                return
            if select.select([master], [], [], 1)[0]:
                buffer += os.read(master, 65536)
        raise AssertionError(f"Terminal did not show {needle!r}")

    try:
        wait_for(b"Press ctrl+o")
        buffer = b""
        os.write(master, b"hello\r")
        if mode == "async":
            wait_for(b"/answer 1")
            buffer = b""
            os.write(master, b"/answer 1\r")
        wait_for("直接入力もできます".encode())
        buffer = b""
        if choose_option:
            os.write(master, b"\x1b[B")
            os.write(master, b"\r")
        else:
            os.write(master, response.encode() + b"\r")
        deadline = time.monotonic() + 15
        role = "tool" if mode == "sync" else "user"
        while time.monotonic() < deadline:
            if any(any(message.get("role") == role and expected in json.dumps(message.get("content"), ensure_ascii=False) for message in request.get("messages", [])) for request in requests):
                break
            if select.select([master], [], [], 0.05)[0]:
                buffer += os.read(master, 65536)
        else:
            raise AssertionError(f"{mode} answer was not delivered")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
        server.shutdown()
        server.server_close()
        shutil.rmtree(directory)


exercise("sync", "日本語の回答", "日本語の回答")
exercise("async", "direct answer", "direct answer")
exercise("sync", "", "User answered: B", choose_option=True)
print("Pi TUI: direct sync/async input and option navigation")
