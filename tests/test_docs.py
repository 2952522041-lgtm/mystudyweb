from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TECHNICAL_SOLUTION = PROJECT_ROOT / "docs" / "TECHNICAL_SOLUTION.md"
PRODUCT_DESIGN = PROJECT_ROOT / "PRODUCT_DESIGN.md"


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


class ProductDesignDocumentTest(unittest.TestCase):
    def test_ai_page_qa_extension_is_documented(self) -> None:
        content = PRODUCT_DESIGN.read_text(encoding="utf-8")

        required_sections = (
            "## 11. 拓展模块：AI 当前页答疑",
            "### 11.3 当前页上下文",
            "### 11.4 翻页与会话规则",
            "### 11.5 独立 AI 服务配置",
            "### 11.8 验收标准",
        )

        for section in required_sections:
            with self.subTest(section=section):
                self.assertIn(section, content)

    def test_ai_page_qa_requires_visual_context_and_is_page_scoped(self) -> None:
        content = PRODUCT_DESIGN.read_text(encoding="utf-8")

        for requirement in (
            "当前页渲染得到的页面图像",
            "模型必须支持视觉输入",
            "每个文档的每一页拥有独立对话记录",
            "切换到 AI 答疑模式本身不触发上传或请求",
            "API Key",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)


if __name__ == "__main__":
    unittest.main()
