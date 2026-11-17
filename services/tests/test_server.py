"""Protocol tests for the stdio backend. Standard library only.

Run with: python -m unittest discover -s services/tests -v
"""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr

from felyrics.errors import ServiceError
from felyrics.server import METHODS, ProtocolError, respond, serve


def parse(line):
    return respond(line)


class RespondTest(unittest.TestCase):
    def test_ping_echoes_the_id(self):
        self.assertEqual(parse('{"id":1,"method":"ping"}'), {
            "id": 1,
            "result": {"pong": True},
        })

    def test_missing_params_defaults_to_an_empty_object(self):
        self.assertEqual(parse('{"id":7,"method":"ping"}')["id"], 7)

    def test_invalid_json_has_no_id(self):
        response = parse("{not json")

        self.assertIsNone(response["id"])
        self.assertEqual(response["error"]["code"], "protocol/invalid-json")

    def test_non_object_request_is_refused(self):
        response = parse("[1,2,3]")

        self.assertEqual(response["error"]["code"], "protocol/invalid-request")

    def test_unknown_method_is_named(self):
        response = parse('{"id":2,"method":"nope"}')

        self.assertEqual(response["id"], 2)
        self.assertEqual(response["error"]["code"], "method/not-found")
        self.assertIn("nope", response["error"]["message"])

    def test_params_must_be_an_object(self):
        response = parse('{"id":3,"method":"ping","params":[1]}')

        self.assertEqual(response["error"]["code"], "protocol/invalid-request")

    def test_handler_crash_answers_without_dying(self):
        def boom(params):
            raise RuntimeError("handler exploded")

        METHODS["boom"] = boom

        try:
            with redirect_stderr(io.StringIO()) as stderr:
                response = parse('{"id":4,"method":"boom"}')

            self.assertEqual(response["id"], 4)
            self.assertEqual(response["error"]["code"], "internal/error")
            self.assertIn("handler exploded", stderr.getvalue())
        finally:
            del METHODS["boom"]

    def test_a_handler_error_keeps_its_code(self):
        def refuse(params):
            raise ServiceError("media/open-failed", "cannot open it")

        METHODS["refuse"] = refuse

        try:
            response = parse('{"id":5,"method":"refuse"}')
        finally:
            del METHODS["refuse"]

        self.assertEqual(response["id"], 5)
        self.assertEqual(
            response["error"],
            {"code": "media/open-failed", "message": "cannot open it"},
        )


class ServeTest(unittest.TestCase):
    def test_writes_one_line_per_request_and_skips_blanks(self):
        stdin = io.StringIO(
            '{"id":1,"method":"ping"}\n\n{"id":2,"method":"ping"}\n'
        )
        stdout = io.StringIO()

        serve(stdin, stdout)

        lines = stdout.getvalue().splitlines()

        self.assertEqual(len(lines), 2)
        self.assertEqual([json.loads(line)["id"] for line in lines], [1, 2])

    def test_each_line_is_a_complete_json_object(self):
        stdout = io.StringIO()

        serve(io.StringIO('{"id":1,"method":"ping"}\n'), stdout)

        self.assertTrue(stdout.getvalue().endswith("\n"))
        json.loads(stdout.getvalue())
