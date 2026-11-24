"""The host entry point, exercised as a real process.

Standard library only. Run with:
    python -m unittest discover -s packages/host/backend/tests -v
"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

REGISTER = """
def serve(ctx):
    ctx.method("echo", lambda params: {"echo": params})
"""


class HostMainTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write_plugin(
        self,
        plugin_id="fixtures.echo",
        *,
        module="echo_plugin",
        source=REGISTER,
        methods=("echo",),
        mutate=None,
    ):
        scope, short = plugin_id.split(".", 1)
        directory = self.root / plugin_id
        backend = directory / "backend"
        backend.mkdir(parents=True)
        (backend / f"{module}.py").write_text(
            textwrap.dedent(source), encoding="utf-8"
        )

        package = {
            "name": f"@{scope}/{short}",
            "version": "0.1.0",
            "author": "Fixture Author",
            "main": "dist/index.js",
            "felyrics": {
                "api": 1,
                "host": "renderer",
                "backend": {"python": f"{module}:serve"},
                "engines": {"python": ">=3.10"},
                "contributes": {
                    "methods": list(methods),
                    "internal": list(methods),
                },
            },
        }

        if mutate is not None:
            mutate(package)

        (directory / "package.json").write_text(
            json.dumps(package), encoding="utf-8"
        )
        return directory

    def environment(self):
        environment = dict(os.environ)
        prior = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = (
            f"{BACKEND}{os.pathsep}{prior}" if prior else str(BACKEND)
        )
        environment["PYTHONDONTWRITEBYTECODE"] = "1"

        return environment

    def run_host(self, arguments, stdin, *, timeout=20):
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "felyrics_host",
                "--cache",
                str(self.root),
                *arguments,
            ],
            input=stdin,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=self.environment(),
        )

    def test_the_cache_directory_is_required(self):
        result = subprocess.run(
            [sys.executable, "-m", "felyrics_host"],
            input="",
            text=True,
            capture_output=True,
            env=self.environment(),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("--cache", result.stderr)

    def test_ping_and_protocol_errors_share_one_loop(self):
        result = self.run_host(
            [],
            '{"v":1,"id":1,"method":"ping"}\n{not json\n',
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines()]

        self.assertEqual(lines[0]["result"], {"pong": True})
        self.assertEqual(lines[1]["error"]["code"], "protocol/bad-request")

    def test_a_plugin_method_is_reachable_by_its_scoped_name(self):
        plugin = self.write_plugin()

        result = self.run_host(
            ["--plugin-dir", str(plugin)],
            '{"v":1,"id":1,"method":"ping"}\n'
            '{"v":1,"id":2,"method":"fixtures.echo/echo","params":{"hi":1}}\n',
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines()]

        self.assertEqual(lines[1]["result"], {"echo": {"hi": 1}})

    def test_two_plugins_may_share_a_short_name(self):
        first = self.write_plugin(
            "fixtures.one",
            module="one_plugin",
            source="""
            def serve(ctx):
                ctx.method("probe", lambda params: {"from": "one"})
            """,
            methods=("probe",),
        )
        second = self.write_plugin(
            "fixtures.two",
            module="two_plugin",
            source="""
            def serve(ctx):
                ctx.method("probe", lambda params: {"from": "two"})
            """,
            methods=("probe",),
        )

        result = self.run_host(
            ["--plugin-dir", str(first), "--plugin-dir", str(second)],
            '{"v":1,"id":1,"method":"fixtures.one/probe"}\n'
            '{"v":1,"id":2,"method":"fixtures.two/probe"}\n'
            '{"v":1,"id":3,"method":"probe"}\n',
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines()]

        self.assertEqual(lines[0]["result"], {"from": "one"})
        self.assertEqual(lines[1]["result"], {"from": "two"})
        self.assertEqual(
            lines[2]["error"]["code"], "protocol/unknown-method"
        )

    def test_a_broken_manifest_exits_before_plugin_code(self):
        plugin = self.write_plugin(
            source="""
            from pathlib import Path

            Path(__file__).with_name("imported.marker").write_text("yes")
            """,
            mutate=lambda package: package["felyrics"].__setitem__(
                "wat", True
            ),
        )

        result = self.run_host(["--plugin-dir", str(plugin)], "")

        self.assertEqual(result.returncode, 1)
        self.assertIn("core/manifest-invalid", result.stderr)
        self.assertFalse(
            (plugin / "backend" / "imported.marker").exists()
        )

    def test_requesting_an_unknown_plugin_fails(self):
        result = self.run_host(["--plugin", "fixtures.nope"], "")

        self.assertEqual(result.returncode, 1)
        self.assertIn("core/backend-failed", result.stderr)

    def test_only_the_requested_plugin_is_loaded(self):
        echo = self.write_plugin()
        other = self.write_plugin(
            "fixtures.other",
            module="other_plugin",
            source="""
            def serve(ctx):
                ctx.method("other", lambda params: {"other": True})
            """,
            methods=("other",),
        )

        result = self.run_host(
            [
                "--plugin-dir",
                str(echo),
                "--plugin-dir",
                str(other),
                "--plugin",
                "fixtures.other",
            ],
            '{"v":1,"id":1,"method":"fixtures.echo/echo"}\n'
            '{"v":1,"id":2,"method":"fixtures.other/other"}\n',
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines()]

        self.assertEqual(
            lines[0]["error"]["code"], "protocol/unknown-method"
        )
        self.assertEqual(lines[1]["result"], {"other": True})


if __name__ == "__main__":
    unittest.main()
