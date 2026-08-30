from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TECHNICAL_SOLUTION = PROJECT_ROOT / "docs" / "TECHNICAL_SOLUTION.md"


class TechnicalSolutionDocumentTest(unittest.TestCase):
    def test_document_exists_and_is_not_empty(self) -> None:
        self.assertTrue(TECHNICAL_SOLUTION.is_file())
        self.assertGreater(TECHNICAL_SOLUTION.stat().st_size, 1_000)

    def test_document_covers_required_mvp_topics(self) -> None:
        content = TECHNICAL_SOLUTION.read_text(encoding="utf-8")
        required_sections = (
            "## 2. 技术选型结论",
            "## 3. 总体架构",
            "## 4. 前端应用方案",
            "## 6. 翻译链路",
            "## 7. 本地存储设计",
            "## 8. 隐私与安全",
            "## 10. 测试策略",
            "## 12. 分阶段实施",
            "## 13. 关键风险与取舍",
        )

        for section in required_sections:
            with self.subTest(section=section):
                self.assertIn(section, content)

    def test_selected_core_technologies_are_documented(self) -> None:
        content = TECHNICAL_SOLUTION.read_text(encoding="utf-8")

        for technology in ("Tauri 2", "React", "TypeScript", "PDF.js", "SQLite"):
            with self.subTest(technology=technology):
                self.assertIn(technology, content)


if __name__ == "__main__":
    unittest.main()
