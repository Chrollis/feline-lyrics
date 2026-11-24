"""Manifest validation: the gate that runs before any plugin code.

Standard library only. Run with:
    python -m unittest discover -s packages/host/backend/tests -v
"""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from felyrics_host.manifest import PluginError, load_manifest

BASE = {
    "name": "@felyrics/echo",
    "version": "0.1.0",
    "author": "Fixture Author",
    "main": "dist/index.js",
    "felyrics": {
        "api": 1,
        "host": "renderer",
        "backend": {"python": "echo_plugin:serve"},
        "engines": {"python": ">=3.10"},
        "contributes": {
            "methods": ["probe"],
            "internal": ["probe"],
        },
    },
}


class ManifestTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write(self, package, directory="felyrics.echo"):
        path = self.root / directory
        path.mkdir(parents=True, exist_ok=True)
        (path / "package.json").write_text(
            json.dumps(package), encoding="utf-8"
        )
        return path

    def package(self):
        return copy.deepcopy(BASE)

    def expect(self, code, package, directory="felyrics.echo"):
        path = self.write(package, directory)

        with self.assertRaises(PluginError) as caught:
            load_manifest(path)

        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_a_scoped_name_derives_the_id(self):
        manifest = load_manifest(self.write(self.package()))

        self.assertEqual(manifest.id, "felyrics.echo")
        self.assertEqual(manifest.api, 1)
        self.assertEqual(manifest.host, "renderer")
        self.assertEqual(manifest.python, "echo_plugin:serve")
        self.assertEqual(manifest.engines_python, ">=3.10")
        self.assertEqual(manifest.methods, ("probe",))
        self.assertEqual(manifest.internal, ("probe",))
        self.assertEqual(manifest.directory.name, "felyrics.echo")

    def test_a_plain_name_with_publisher_derives_the_same_id(self):
        package = self.package()
        package["name"] = "echo"
        package["publisher"] = "felyrics"

        manifest = load_manifest(self.write(package))

        self.assertEqual(manifest.id, "felyrics.echo")

    def test_a_scoped_name_must_not_declare_publisher(self):
        package = self.package()
        package["publisher"] = "felyrics"

        error = self.expect("core/manifest-invalid", package)

        self.assertIn("publisher", [issue["path"] for issue in error.issues])

    def test_a_plain_name_requires_publisher(self):
        package = self.package()
        package["name"] = "echo"

        error = self.expect(
            "core/manifest-invalid", package, directory="echo"
        )

        self.assertIn("publisher", [issue["path"] for issue in error.issues])

    def test_the_directory_must_match_the_id(self):
        error = self.expect(
            "core/identity-mismatch",
            self.package(),
            directory="felyrics.other",
        )

        self.assertEqual(error.issues[0]["path"], "directory")

    def test_unknown_key_inside_felyrics_is_refused(self):
        package = self.package()
        package["felyrics"]["wat"] = True

        error = self.expect("core/manifest-invalid", package)

        self.assertIn("felyrics.wat", [issue["path"] for issue in error.issues])

    def test_unknown_key_inside_backend_is_refused(self):
        package = self.package()
        package["felyrics"]["backend"]["worker"] = "worker.js"

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.backend.worker",
            [issue["path"] for issue in error.issues],
        )

    def test_unknown_key_inside_contributes_is_refused(self):
        package = self.package()
        package["felyrics"]["contributes"]["hooks"] = []

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.hooks",
            [issue["path"] for issue in error.issues],
        )

    def test_an_unsupported_api_is_its_own_error(self):
        package = self.package()
        package["felyrics"]["api"] = 2

        self.expect("core/api-unsupported", package)

    def test_api_must_be_an_integer(self):
        package = self.package()
        package["felyrics"]["api"] = True

        error = self.expect("core/manifest-invalid", package)

        self.assertIn("felyrics.api", [issue["path"] for issue in error.issues])

    def test_host_must_be_renderer_or_utility(self):
        package = self.package()
        package["felyrics"]["host"] = "web"

        error = self.expect("core/manifest-invalid", package)

        self.assertIn("felyrics.host", [issue["path"] for issue in error.issues])

    def test_backend_has_at_most_one_label(self):
        package = self.package()
        package["felyrics"]["backend"]["exec"] = "bin/plugin"

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.backend",
            [issue["path"] for issue in error.issues],
        )

    def test_a_python_backend_requires_engines(self):
        package = self.package()
        del package["felyrics"]["engines"]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.engines", [issue["path"] for issue in error.issues]
        )

    def test_engines_need_a_python_backend(self):
        package = self.package()
        del package["felyrics"]["backend"]
        del package["felyrics"]["contributes"]["internal"]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.engines", [issue["path"] for issue in error.issues]
        )

    def test_internal_is_required_with_a_backend(self):
        package = self.package()
        del package["felyrics"]["contributes"]["internal"]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.internal",
            [issue["path"] for issue in error.issues],
        )

    def test_internal_is_forbidden_without_a_backend(self):
        package = self.package()
        del package["felyrics"]["backend"]
        del package["felyrics"]["engines"]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.internal",
            [issue["path"] for issue in error.issues],
        )

    def test_method_names_are_lowercase_kebab(self):
        package = self.package()
        package["felyrics"]["contributes"]["methods"] = ["Probe"]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.methods[0]",
            [issue["path"] for issue in error.issues],
        )

    def test_python_target_shape_is_checked(self):
        package = self.package()
        package["felyrics"]["backend"]["python"] = "not-a-target"

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.backend.python",
            [issue["path"] for issue in error.issues],
        )

    def test_an_unsatisfied_engine_is_reported(self):
        package = self.package()
        package["felyrics"]["engines"]["python"] = ">=99.0"

        self.expect("core/engine-unsatisfied", package)

    def test_version_must_be_semver(self):
        package = self.package()
        package["version"] = "1.0"

        error = self.expect("core/manifest-invalid", package)

        self.assertIn("version", [issue["path"] for issue in error.issues])

    def test_main_must_stay_inside_the_package(self):
        package = self.package()
        package["main"] = "../escape.js"

        error = self.expect("core/manifest-invalid", package)

        self.assertIn("main", [issue["path"] for issue in error.issues])

    def test_duplicate_methods_are_refused(self):
        package = self.package()
        package["felyrics"]["contributes"]["methods"] = ["probe", "probe"]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.methods[1]",
            [issue["path"] for issue in error.issues],
        )

    def test_a_ts_only_plugin_needs_no_internal(self):
        package = self.package()
        del package["felyrics"]["backend"]
        del package["felyrics"]["engines"]
        del package["felyrics"]["contributes"]["internal"]

        manifest = load_manifest(self.write(package))

        self.assertIsNone(manifest.python)
        self.assertEqual(manifest.internal, ())

    def test_a_broken_package_json_is_manifest_invalid(self):
        path = self.root / "felyrics.echo"
        path.mkdir()
        (path / "package.json").write_text("{not json", encoding="utf-8")

        with self.assertRaises(PluginError) as caught:
            load_manifest(path)

        self.assertEqual(caught.exception.code, "core/manifest-invalid")

    def test_a_missing_package_json_is_manifest_invalid(self):
        path = self.root / "felyrics.echo"
        path.mkdir()

        with self.assertRaises(PluginError) as caught:
            load_manifest(path)

        self.assertEqual(caught.exception.code, "core/manifest-invalid")
    def test_commands_are_optional_and_carry_a_title(self):
        package = self.package()
        package["felyrics"]["contributes"]["commands"] = [
            {"id": "pick-audio", "title": "Pick audio"},
            {"id": "decode-audio", "title": "Decode audio"},
        ]

        manifest = load_manifest(self.write(package))

        self.assertEqual(
            [(command.id, command.title) for command in manifest.commands],
            [("pick-audio", "Pick audio"), ("decode-audio", "Decode audio")],
        )

    def test_a_plugin_without_commands_has_an_empty_tuple(self):
        manifest = load_manifest(self.write(self.package()))

        self.assertEqual(manifest.commands, ())

    def test_command_ids_must_be_lowercase_kebab(self):
        package = self.package()
        package["felyrics"]["contributes"]["commands"] = [
            {"id": "PickAudio", "title": "Pick audio"},
        ]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.commands[0].id",
            [issue["path"] for issue in error.issues],
        )

    def test_command_ids_are_unique(self):
        package = self.package()
        package["felyrics"]["contributes"]["commands"] = [
            {"id": "pick-audio", "title": "Pick audio"},
            {"id": "pick-audio", "title": "Pick again"},
        ]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.commands[1].id",
            [issue["path"] for issue in error.issues],
        )

    def test_a_command_needs_a_non_empty_title(self):
        package = self.package()
        package["felyrics"]["contributes"]["commands"] = [
            {"id": "pick-audio", "title": ""},
        ]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.commands[0].title",
            [issue["path"] for issue in error.issues],
        )

    def test_unknown_command_keys_are_refused(self):
        package = self.package()
        package["felyrics"]["contributes"]["commands"] = [
            {"id": "pick-audio", "title": "Pick audio", "icon": "x"},
        ]

        error = self.expect("core/manifest-invalid", package)

        self.assertIn(
            "felyrics.contributes.commands[0].icon",
            [issue["path"] for issue in error.issues],
        )


if __name__ == "__main__":
    unittest.main()
