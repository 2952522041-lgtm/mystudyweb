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
            "## 15. AI 当前页视觉答疑技术方案",
            "## 16. 本地课程知识库与增量脑图技术方案",
        )

        for section in required_sections:
            with self.subTest(section=section):
                self.assertIn(section, content)

    def test_selected_core_technologies_are_documented(self) -> None:
        content = TECHNICAL_SOLUTION.read_text(encoding="utf-8")

        for technology in ("Tauri 2", "React", "TypeScript", "PDF.js", "SQLite"):
            with self.subTest(technology=technology):
                self.assertIn(technology, content)

    def test_visual_page_qa_technical_design_is_complete(self) -> None:
        content = TECHNICAL_SOLUTION.read_text(encoding="utf-8")

        required_sections = (
            "### 15.2 当前页视觉图像生成",
            "### 15.3 多模态答疑供应商接口",
            "### 15.5 对话协调与翻页归属",
            "### 15.6 本地存储设计",
            "### 15.7 回答渲染与界面拆分",
            "### 15.9 测试策略",
        )

        for section in required_sections:
            with self.subTest(section=section):
                self.assertIn(section, content)

    def test_visual_page_qa_uses_lightweight_existing_stack(self) -> None:
        content = TECHNICAL_SOLUTION.read_text(encoding="utf-8")

        for requirement in (
            "PDF.js + Canvas API",
            "OpenAI-compatible Chat Completions",
            "Fetch + ReadableStream + SSE",
            "React Markdown + GFM + KaTeX",
            "chat:{documentFingerprint}:{pageNumber}",
            "不需要 LangChain",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)

    def test_local_course_knowledge_base_design_is_complete(self) -> None:
        content = TECHNICAL_SOLUTION.read_text(encoding="utf-8")

        required_sections = (
            "### 16.2 课程目录与可信数据边界",
            "### 16.3 PDF 导入与去重",
            "### 16.4 内部摘要与用户可见成果",
            "### 16.5 课程增量合并",
            "### 16.7 存储适配边界",
            "### 16.9 测试策略",
        )

        for section in required_sections:
            with self.subTest(section=section):
                self.assertIn(section, content)

        for requirement in (
            "BrowserDirectoryStorage",
            "课程目录中的结构化文件是业务数据的唯一可信来源",
            "每份 PDF 都生成内部 `DocumentDigest`",
            "我的课程笔记.md",
            "API Key",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)


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

    def test_local_course_summary_and_mindmap_are_documented(self) -> None:
        content = PRODUCT_DESIGN.read_text(encoding="utf-8")

        required_sections = (
            "## 12. 拓展模块：本地课程知识库与脑图",
            "### 12.2 创建课程与绑定文件夹",
            "### 12.3 PDF 导入与生成选项",
            "### 12.5 课程总总结与总脑图",
            "### 12.7 本地成果与版本",
            "### 12.9 验收标准",
        )

        for section in required_sections:
            with self.subTest(section=section):
                self.assertIn(section, content)

        for requirement in (
            "第一版只支持绑定本地课程文件夹这一种课程存储模式",
            "每份 PDF 无论是否生成可见成果，都要生成",
            "课程文件夹是课程数据的唯一可信来源",
            "用户笔记不会被 AI 更新覆盖",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)


if __name__ == "__main__":
    unittest.main()
