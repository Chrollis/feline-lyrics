"""Plugin activation: manifest gate, serve(ctx), and the registry comparison.

Standard library only. Run with:
    python -m unittest discover -s packages/host/backend/tests -v
"""

import json
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Fixture modules are imported from temporary directories; bytecode would keep
# the cleanup busy on Windows and prove nothing here.
sys.dont_write_bytecode = True

from felyrics_host.ctx import BackendContext
from felyrics_host.loader import load_plugin, load_plugins
from felyrics_host.manifest import PluginError
from felyrics_host.registry import Registry

REGISTER = """
def serve(ctx):
    ctx.method("echo", lambda params: {"echo": params})
"""


class LoaderTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def module(self):
        return f"fixture_{self._testMethodName}"

    def build(
        self,
        *,
        module,
        source,
        plugin_id="fixtures.echo",
        methods=("echo",),
        internal=None,
        with_backend=True,
        parent=None,
        mutate=None,
    ):
        scope, short = plugin_id.split(".", 1)
        directory = (parent or self.root) / plugin_id
        directory.mkdir(parents=True)

        if with_backend:
            backend = directory / "backend"
            backend.mkdir()
            (backend / f"{module}.py").write_text(
                textwrap.dedent(source), encoding="utf-8"
            )

        felyrics = {
            "api": 1,
            "host": "renderer",
            "contributes": {"methods": list(methods)},
        }

        if with_backend:
            felyrics["backend"] = {"python": f"{module}:serve"}
            felyrics["engines"] = {"python": ">=3.10"}
            felyrics["contributes"]["internal"] = list(
                internal if internal is not None else methods
            )

        package = {
            "name": f"@{scope}/{short}",
            "version": "0.1.0",
            "author": "Fixture Author",
            "main": "dist/index.js",
            "felyrics": felyrics,
        }

        if mutate is not None:
            mutate(package)

        (directory / "package.json").write_text(
            json.dumps(package), encoding="utf-8"
        )
        return directory

    def test_loads_a_plugin_and_registers_its_methods(self):
        path = self.build(module=self.module(), source=REGISTER)

        loaded = load_plugin(path)

        self.assertEqual(loaded.manifest.id, "fixtures.echo")
        self.assertEqual(tuple(loaded.registry.handlers()), ("echo",))
        self.assertEqual(
            loaded.registry.handlers()["echo"]({"a": 1}),
            {"echo": {"a": 1}},
        )

    def test_a_missing_registration_is_a_mismatch(self):
        path = self.build(
            module=self.module(),
            source="def serve(ctx):\n    pass\n",
        )

        with self.assertRaises(PluginError) as caught:
            load_plugin(path)

        self.assertEqual(caught.exception.code, "core/methods-mismatch")
        self.assertIn(
            "contributes.internal[0]",
            [issue["path"] for issue in caught.exception.issues],
        )

    def test_an_extra_registration_is_a_mismatch(self):
        source = """
        def serve(ctx):
            ctx.method("echo", lambda params: {"echo": params})
            ctx.method("extra", lambda params: {})
        """
        path = self.build(module=self.module(), source=source)

        with self.assertRaises(PluginError) as caught:
            load_plugin(path)

        self.assertEqual(caught.exception.code, "core/methods-mismatch")
        self.assertTrue(
            any(
                "registered but is not declared" in issue["message"]
                for issue in caught.exception.issues
            )
        )

    def test_manifest_errors_never_run_plugin_code(self):
        module = self.module()
        source = """
        from pathlib import Path

        Path(__file__).with_name("imported.marker").write_text("yes")

        def serve(ctx):
            pass
        """
        path = self.build(
            module=module,
            source=source,
            mutate=lambda package: package["felyrics"].__setitem__(
                "wat", True
            ),
        )

        with self.assertRaises(PluginError) as caught:
            load_plugin(path)

        self.assertEqual(caught.exception.code, "core/manifest-invalid")
        self.assertFalse((path / "backend" / "imported.marker").exists())

    def test_serve_errors_are_backend_failed(self):
        path = self.build(
            module=self.module(),
            source='def serve(ctx):\n    raise RuntimeError("boom")\n',
        )

        with self.assertRaises(PluginError) as caught:
            load_plugin(path)

        self.assertEqual(caught.exception.code, "core/backend-failed")
        self.assertIn("boom", caught.exception.message)

    def test_import_errors_are_backend_failed(self):
        path = self.build(
            module=self.module(),
            source="",
            mutate=lambda package: package["felyrics"]["backend"].__setitem__(
                "python", "missing_module_xyz:serve"
            ),
        )

        with self.assertRaises(PluginError) as caught:
            load_plugin(path)

        self.assertEqual(caught.exception.code, "core/backend-failed")

    def test_a_missing_backend_directory_is_backend_failed(self):
        path = self.build(module=self.module(), source=REGISTER)
        shutil.rmtree(path / "backend")

        with self.assertRaises(PluginError) as caught:
            load_plugin(path)

        self.assertEqual(caught.exception.code, "core/backend-failed")

    def test_a_ts_only_plugin_loads_without_running_code(self):
        path = self.build(
            module=self.module(),
            source="",
            methods=("probe",),
            with_backend=False,
        )

        loaded = load_plugin(path)

        self.assertIsNone(loaded.manifest.python)
        self.assertEqual(loaded.manifest.internal, ())
        self.assertEqual(tuple(loaded.registry.handlers()), ())

    def test_duplicate_ids_are_refused(self):
        first = self.build(
            module=self.module() + "_one",
            source=REGISTER,
            parent=self.root / "one",
        )
        second = self.build(
            module=self.module() + "_two",
            source=REGISTER,
            parent=self.root / "two",
        )

        with self.assertRaises(PluginError) as caught:
            load_plugins([first, second], [])

        self.assertEqual(caught.exception.code, "core/duplicate-id")

    def test_requesting_a_missing_plugin_fails(self):
        path = self.build(module=self.module(), source=REGISTER)

        with self.assertRaises(PluginError) as caught:
            load_plugins([path], ["fixtures.nope"])

        self.assertEqual(caught.exception.code, "core/backend-failed")

    def test_requesting_a_subset_loads_only_it(self):
        echo = self.build(module=self.module() + "_echo", source=REGISTER)
        other = self.build(
            module=self.module() + "_other",
            source=REGISTER,
            plugin_id="fixtures.other",
        )

        loaded = load_plugins([echo, other], ["fixtures.other"])

        self.assertEqual([plugin.manifest.id for plugin in loaded], ["fixtures.other"])

    def test_registration_after_freeze_is_refused(self):
        registry = Registry("fixtures.echo")
        context = BackendContext("fixtures.echo", 1, (), registry)
        context.method("echo", lambda params: params)
        registry.freeze()

        with self.assertRaises(PluginError) as caught:
            context.method("late", lambda params: params)

        self.assertEqual(caught.exception.code, "core/methods-mismatch")

    def test_a_duplicate_registration_is_refused(self):
        registry = Registry("fixtures.echo")
        context = BackendContext("fixtures.echo", 1, (), registry)
        context.method("echo", lambda params: params)

        with self.assertRaises(PluginError) as caught:
            context.method("echo", lambda params: params)

        self.assertEqual(caught.exception.code, "core/methods-mismatch")

    def test_context_exposes_identity_and_api(self):
        registry = Registry("fixtures.echo")
        context = BackendContext("fixtures.echo", 1, (), registry)

        self.assertEqual(context.plugin_id, "fixtures.echo")
        self.assertEqual(context.api, 1)


if __name__ == "__main__":
    unittest.main()
