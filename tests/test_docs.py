from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TECHNICAL_SOLUTION = PROJECT_ROOT / "docs" / "TECHNICAL_SOLUTION.md"
PRODUCT_DESIGN = PROJECT_ROOT / "PRODUCT_DESIGN.md"
HANDOFF = PROJECT_ROOT / "HANDOFF.md"


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
            "### 15.4 联网检索与来源边界",
            "### 15.6 对话协调与翻页归属",
            "### 15.7 本地存储设计",
            "### 15.8 回答渲染与界面拆分",
            "### 15.10 测试策略",
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
            "智谱 Web Search API",
            "真实 URL",
            "不需要 LangChain",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)

    def test_local_course_knowledge_base_design_is_complete(self) -> None:
        content = TECHNICAL_SOLUTION.read_text(encoding="utf-8")

        required_sections = (
            "### 16.1 技术栈与模块边界",
            "### 16.3 课程目录与可信数据边界",
            "### 16.4 PDF 导入与去重",
            "### 16.5 内部摘要与用户可见成果",
            "### 16.6 课程增量合并",
            "### 16.8 存储适配边界",
            "### 16.10 测试策略",
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
            "@xyflow/react",
            "elkjs",
            "Zod",
            "interface KnowledgeProvider",
            "不需要 LangChain、向量数据库、全文 RAG",
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

    def test_ai_page_qa_allows_external_knowledge_and_real_web_search(self) -> None:
        content = PRODUCT_DESIGN.read_text(encoding="utf-8")

        for requirement in (
            "当前页是答疑的主要阅读上下文，而不是唯一知识来源",
            "应用应先执行真实搜索",
            "可点击的来源链接",
            "只有实际取得搜索结果时才能声称已经联网搜索",
            "可能产生供应商搜索费用",
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


class HandoffDocumentTest(unittest.TestCase):
    def test_desktop_handoff_is_actionable(self) -> None:
        content = HANDOFF.read_text(encoding="utf-8")

        for requirement in (
            "## 七、最新诊断与用户最终决定（桌面迁移的背景）",
            "## 八、推荐桌面架构（Electron）",
            "path.join(app.getPath('documents'), '页语工作区')",
            "YEYU_WORKSPACE_ROOT=/home/yusicheng/Documents/1",
            "contextIsolation: true",
            "DesktopCourseStorage",
            "build-windows-desktop.yml",
            "## 十、测试与验收清单",
            "0927988 feat: add visual OCR for scanned PDFs",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)

    def test_handoff_keeps_web_and_desktop_responsibilities_separate(self) -> None:
        content = HANDOFF.read_text(encoding="utf-8")

        for requirement in (
            "浏览器版本继续使用 `BrowserDirectoryStorage`",
            "桌面版本使用 `DesktopCourseStorage`",
            "不要覆盖它。桌面工作流与 Pages 工作流分开",
            "不要开启 `nodeIntegration: true`",
            "API Key 不出现在课程目录、日志、提交或安装包中",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)

    def test_handoff_records_desktop_runtime_blockers(self) -> None:
        """第十三节保留原始问题记录，避免后人重蹈覆辙。"""
        content = HANDOFF.read_text(encoding="utf-8")

        for requirement in (
            "## 十三、Windows 机器接手前的 Codex 复核结论（必须先处理）",
            "Error: module not found: ./api.js",
            "把 `preload.ts` 及 `api.ts` 打包成单个 CommonJS `preload.js`",
            "Windows Squirrel 安装器缺少必填元数据",
            "setWindowOpenHandler",
            "不要关闭 Electron sandbox",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)

    def test_handoff_records_desktop_runtime_fixes_and_remaining_work(self) -> None:
        """阻断项修复后，HANDOFF 必须给出解决状态与剩余平台验收清单。"""
        content = HANDOFF.read_text(encoding="utf-8")

        for requirement in (
            "## 十四、2026-08-31 桌面阻断项修复记录（GLM）",
            "### 13.1 阻断：sandbox preload 不能加载拆分的本地 CommonJS 模块",
            "已修复（提交 `6dac911`）",
            "已修复（提交 `ce3d6ef`）",
            "外部导航隔离：已实现",
            "tests/electron-smoke.smoke.ts",
            "yeyu_0.1.0_amd64.deb",
            "Windows Squirrel make：尚未执行（需 windows-latest runner）",
            "Ubuntu DEB 实机安装：构建产物已核对",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)

    def test_readme_documents_desktop_install_and_boundaries(self) -> None:
        content = (PROJECT_ROOT / "README.md").read_text(encoding="utf-8")

        for requirement in (
            "## 桌面版（Electron）",
            "sudo apt install ./out/make/deb/x64/yeyu_0.1.0_amd64.deb",
            "GNOME 应用菜单出现「页语」",
            "~/Documents/页语工作区",
            "build-windows-desktop.yml",
            "sandbox: true",
            "setWindowOpenHandler` 默认 deny",
            "pnpm desktop:test",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, content)


class OptimizationPlanDocumentTest(unittest.TestCase):
    def test_execution_status_reports_actual_scope_and_compatibility(self) -> None:
        content = (PROJECT_ROOT / "docs" / "AC-OPTIMIZATION-PLAN.md").read_text(encoding="utf-8")
        status = content.split("## 执行状态（2026-09-26）", 1)[1].split("\n---", 1)[0]
        for item in ("C1", "C2", "C3", "A1", "A3", "P1 PDF 导入生命周期",
                     "P1 答疑存储异常处理", "P2 首屏等待全部页面尺寸", "P2 阅读器最小高度"):
            with self.subTest(item=item):
                self.assertRegex(status, rf"\| {item}[^|]*\| 已完成 \|")
        self.assertIn("| A2 原文 ↔ 译文逐段对照 | 未做 |", status)
        for boundary in ("chat:{fingerprint}:{pageNumber}", "chat:{fingerprint}:document:v1",
                         "allowWebSearch: false", "doc.loadingTask.destroy()", "不调用 AI", "人工验收"):
            self.assertIn(boundary, status)

if __name__ == "__main__":
    unittest.main()
