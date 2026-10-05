"""Guard upload boundaries without requiring personal configuration."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class RepositoryHygieneTest(unittest.TestCase):
    def test_private_and_generated_paths_are_ignored(self):
        paths = [".env", "demo/.env.local", "demo/node_modules/a.js",
                 "demo/dist/client/index.html", "demo/electron/dist/main.js",
                 "demo/out/app.deb", "demo/Settings/mcp-control.json",
                 "demo/scripts/blackboard/config.json", "demo/debug.log",
                 "demo/.codegraph/index", ".aws/credentials"]
        result = subprocess.run(["git", "check-ignore", "--no-index", "--stdin"],
                                input="\n".join(paths), text=True, capture_output=True,
                                cwd=ROOT, check=False)
        self.assertEqual(set(result.stdout.splitlines()), set(paths))

    def test_required_sources_and_examples_are_not_ignored(self):
        paths = ["demo/app/page.tsx", "demo/app/globals.css",
                 "demo/electron/main.ts", "demo/electron/preload.ts",
                 "demo/components/ui/button.tsx", "demo/lib/openai-client.ts",
                 "demo/public/sample.pdf", "demo/assets/icons/png/yeyu-16.png",
                 "demo/package.json", "demo/pnpm-lock.yaml", "demo/.env.example",
                 "demo/scripts/blackboard/config.example.json",
                 "docs/GEMINI_UI_CONTEXT.md"]
        for path in paths:
            self.assertTrue((ROOT / path).is_file(), path)
        result = subprocess.run(["git", "check-ignore", "--no-index", "--stdin"],
                                input="\n".join(paths), text=True, capture_output=True,
                                cwd=ROOT, check=False)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_environment_example_has_no_values(self):
        for line in (ROOT / "demo/.env.example").read_text().splitlines():
            if line and not line.startswith("#"):
                self.assertEqual(line.split("=", 1)[1], "")
