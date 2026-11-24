"""Protocol tests for the host runtime. Standard library only.

Run with: python -m unittest discover -s packages/host/backend/tests -v
"""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

# The venv's import path names both package roots once provisioning has run.
# the host backend, so this suite finds its package from the checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from felyrics_host.errors import ServiceError
from felyrics_host.server import (
    MAX_LINE_BYTES,
    METHODS,
    PLUGIN_METHODS,
    PROTOCOL_VERSION,
    PluginMethod,
    ProtocolError,
    respond,
    serve,
)


def parse(line):
    return respond(line)


class RespondTest(unittest.TestCase):
    def test_ping_echoes_the_id(self):
        self.assertEqual(parse('{"v":1,"id":1,"method":"ping"}'), {
            "v": 1,
            "id": 1,
            "result": {"pong": True},
        })

    def test_missing_params_defaults_to_an_empty_object(self):
        self.assertEqual(parse('{"v":1,"id":7,"method":"ping"}')["id"], 7)

    def test_invalid_json_has_no_id(self):
        response = parse("{not json")

        self.assertIsNone(response["id"])
        self.assertEqual(response["error"]["code"], "protocol/bad-request")

    def test_non_object_request_is_refused(self):
        response = parse("[1,2,3]")

        self.assertEqual(response["error"]["code"], "protocol/bad-request")

    def test_unknown_method_is_named(self):
        response = parse('{"v":1,"id":2,"method":"nope"}')

        self.assertEqual(response["id"], 2)
        self.assertEqual(response["error"]["code"], "protocol/unknown-method")
        self.assertIn("nope", response["error"]["message"])

    def test_params_must_be_an_object(self):
        response = parse('{"v":1,"id":3,"method":"ping","params":[1]}')

        self.assertEqual(response["error"]["code"], "protocol/bad-request")

    def test_a_plugin_method_is_dispatched(self):
        PLUGIN_METHODS[("fixtures.echo", "echo")] = PluginMethod(
            "fixtures.echo", frozenset(), lambda params: {"echo": params}
        )

        try:
            response = parse(
                '{"v":1,"id":6,"method":"fixtures.echo/echo","params":{"hi":1}}'
            )
        finally:
            del PLUGIN_METHODS[("fixtures.echo", "echo")]

        self.assertEqual(response["result"], {"echo": {"hi": 1}})

        # A bare short name is not the backend's wire form any more: the
        # TypeScript face owns the public table and always sends `<id>/<short>`.
        bare = parse('{"v":1,"id":6,"method":"echo"}')

        self.assertEqual(bare["error"]["code"], "protocol/unknown-method")

    def test_a_declared_plugin_error_keeps_its_code(self):
        def refuse(params):
            raise ServiceError("fixtures.echo/open-failed", "cannot open it")

        PLUGIN_METHODS[("fixtures.echo", "refuse")] = PluginMethod(
            "fixtures.echo", frozenset({"open-failed"}), refuse
        )

        try:
            response = parse('{"v":1,"id":7,"method":"fixtures.echo/refuse"}')
        finally:
            del PLUGIN_METHODS[("fixtures.echo", "refuse")]

        self.assertEqual(
            response["error"],
            {"code": "fixtures.echo/open-failed", "message": "cannot open it"},
        )

    def test_an_undeclared_plugin_error_becomes_internal(self):
        def refuse(params):
            raise ServiceError("fixtures.echo/surprise", "not in the manifest")

        PLUGIN_METHODS[("fixtures.echo", "refuse")] = PluginMethod(
            "fixtures.echo", frozenset({"open-failed"}), refuse
        )

        try:
            response = parse('{"v":1,"id":8,"method":"fixtures.echo/refuse"}')
        finally:
            del PLUGIN_METHODS[("fixtures.echo", "refuse")]

        self.assertEqual(response["error"]["code"], "core/internal")
        self.assertIn("fixtures.echo/surprise", response["error"]["message"])
        self.assertEqual(
            response["error"]["data"], {"originalCode": "fixtures.echo/surprise"}
        )

    def test_another_plugins_error_prefix_becomes_internal(self):
        def refuse(params):
            raise ServiceError("someone.else/open-failed", "not yours")

        PLUGIN_METHODS[("fixtures.echo", "refuse")] = PluginMethod(
            "fixtures.echo", frozenset({"open-failed"}), refuse
        )

        try:
            response = parse('{"v":1,"id":9,"method":"fixtures.echo/refuse"}')
        finally:
            del PLUGIN_METHODS[("fixtures.echo", "refuse")]

        self.assertEqual(response["error"]["code"], "core/internal")
        self.assertEqual(
            response["error"]["data"],
            {"originalCode": "someone.else/open-failed"},
        )

    def test_a_host_code_raised_during_the_call_passes(self):
        def refuse(params):
            raise ServiceError("core/not-ready", "the job kind is not declared")

        PLUGIN_METHODS[("fixtures.echo", "refuse")] = PluginMethod("fixtures.echo", frozenset(), refuse)

        try:
            response = parse('{"v":1,"id":10,"method":"fixtures.echo/refuse"}')
        finally:
            del PLUGIN_METHODS[("fixtures.echo", "refuse")]

        self.assertEqual(response["error"]["code"], "core/not-ready")

    def test_handler_crash_answers_without_dying(self):
        def boom(params):
            raise RuntimeError("handler exploded")

        METHODS["boom"] = boom

        try:
            with redirect_stderr(io.StringIO()) as stderr:
                response = parse('{"v":1,"id":4,"method":"boom"}')

            self.assertEqual(response["id"], 4)
            self.assertEqual(response["error"]["code"], "core/internal")
            self.assertIn("handler exploded", stderr.getvalue())
        finally:
            del METHODS["boom"]

    def test_every_answer_states_the_version_it_speaks(self):
        for line in (
            '{"v":1,"id":1,"method":"ping"}',
            '{"v":1,"id":2,"method":"nope"}',
            "{not json",
        ):
            with self.subTest(line=line):
                self.assertEqual(parse(line)["v"], PROTOCOL_VERSION)

    def test_a_request_from_another_version_is_refused_with_the_id(self):
        response = parse('{"v":2,"id":9,"method":"ping"}')

        # The id survives so the caller can pair the refusal with its request.
        self.assertEqual(response["id"], 9)
        self.assertEqual(
            response["error"]["code"], "protocol/version-mismatch"
        )
        self.assertIn("protocol version 1", response["error"]["message"])
        # Both versions travel as fields, so a client can render them without
        # parsing the sentence above.
        self.assertEqual(
            response["error"]["data"],
            {"declared": 2, "expected": PROTOCOL_VERSION},
        )

    def test_a_request_without_a_version_is_refused(self):
        response = parse('{"id":10,"method":"ping"}')

        self.assertEqual(
            response["error"]["code"], "protocol/version-mismatch"
        )
        self.assertIn("none", response["error"]["message"])
        # "did not send it" is null, not a guess at a number.
        self.assertIsNone(response["error"]["data"]["declared"])

    def test_a_boolean_version_is_not_the_number_one(self):
        # `True == 1` in Python, so a plain equality test would accept this and
        # the TypeScript client would refuse the same answer. Both sides agree.
        response = parse('{"v":true,"id":11,"method":"ping"}')

        self.assertEqual(
            response["error"]["code"], "protocol/version-mismatch"
        )
        self.assertIn("True", response["error"]["message"])

    def test_a_string_version_is_refused(self):
        response = parse('{"v":"1","id":12,"method":"ping"}')

        self.assertEqual(
            response["error"]["code"], "protocol/version-mismatch"
        )
        self.assertIn("'1'", response["error"]["message"])

    def test_a_request_without_an_integer_id_is_refused(self):
        # The id is how an answer is matched to a request, so it is checked
        # before anything else is read. A value that cannot be echoed back as the
        # same integer is refused instead of being passed through as text.
        for line in (
            '{"v":1,"method":"ping"}',
            '{"v":1,"id":"seven","method":"ping"}',
            '{"v":1,"id":true,"method":"ping"}',
            '{"v":1,"id":{"nested":1},"method":"ping"}',
        ):
            with self.subTest(line=line):
                response = parse(line)

                self.assertIsNone(response["id"])
                self.assertEqual(
                    response["error"]["code"], "protocol/bad-request"
                )
                self.assertIn("id", response["error"]["message"])

    def test_a_handler_error_keeps_its_code(self):
        def refuse(params):
            raise ServiceError("core/not-ready", "the host is not ready")

        METHODS["refuse"] = refuse

        try:
            response = parse('{"v":1,"id":5,"method":"refuse"}')
        finally:
            del METHODS["refuse"]

        self.assertEqual(response["id"], 5)
        self.assertEqual(
            response["error"],
            {"code": "core/not-ready", "message": "the host is not ready"},
        )


class ServeTest(unittest.TestCase):
    def test_writes_one_line_per_request_and_skips_blanks(self):
        stdin = io.StringIO(
            '{"v":1,"id":1,"method":"ping"}\n\n{"v":1,"id":2,"method":"ping"}\n'
        )
        stdout = io.StringIO()

        serve(stdin, stdout)

        lines = stdout.getvalue().splitlines()

        self.assertEqual(len(lines), 2)
        self.assertEqual([json.loads(line)["id"] for line in lines], [1, 2])

    def test_each_line_is_a_complete_json_object(self):
        stdout = io.StringIO()

        serve(io.StringIO('{"v":1,"id":1,"method":"ping"}\n'), stdout)

        self.assertTrue(stdout.getvalue().endswith("\n"))
        json.loads(stdout.getvalue())

    def test_a_line_over_the_bound_is_refused_and_the_loop_continues(self):
        stdin = io.StringIO(
            "x" * (MAX_LINE_BYTES + 1)
            + "\n"
            + '{"v":1,"id":2,"method":"ping"}\n'
        )
        stdout = io.StringIO()

        serve(stdin, stdout)

        lines = [json.loads(line) for line in stdout.getvalue().splitlines()]

        self.assertEqual(lines[0]["error"]["code"], "protocol/oversize")
        self.assertEqual(lines[1]["result"], {"pong": True})
