# 脑图层级诊断（基线 6625ce3）

基线：`cd demo && xvfb-run -a pnpm test`，342/342，0 失败、0 跳过。
诊断复现：本次诊断提交上运行 `cd demo && node --test --experimental-strip-types tests/mindmap-hierarchy.test.ts`。

夹具位于 `demo/tests/fixtures/mindmap-hierarchy.ts`，模拟 PDF.js 返回确定的两页文字项，实际调用 extractPdfPages 的规范化/指纹计算，再调用真实 provider 的分块、摘要、课程综合、合并、布局、SVG。只有 PDF.js 边界和网络回答被 mock；不验证 PDF.js 自身解析能力，不访问真实课程目录或真实模型。

实际输出（根节点 depth=0）：

| mock 输出 | PDF 深度/各层数/孤立数 | 课程 深度/各层数/孤立数 |
|---|---|---|
| 平铺且 relations=[] | 1 / [1,8] / 0 | 1 / [1,8] / 0 |
| 含章→节→要点的包含关系 | 3 / [1,2,2,4] / 0 | 3 / [1,2,2,4] / 0 |

```
电路讲义
  电路基础
    电阻电路
      欧姆定律 U=IR
      串联电阻 R=R1+R2
  动态电路
    电容储能
      电容定义 Q=CU
      储能 W=CU²/2
```

a. 主因：并非完全没有关系 schema，而是没有明确父子字段、必选关系/拓扑约束。ai-knowledge-provider.ts:484 起允许缺省 relations；:675 起 digest 只要求“形成有层次”，仍限定 6–16 概念；:692 起课程输入丢掉概念 id 和 relations；:736 起课程校验不验深度、分支或孤立点，未知关系端点直接跳过。平铺 mock 被完整接受证明这一漏洞。

b. 模型：未验证。提示词有弱建议不等于模型服从；没有用户实际模型原始响应，不能断言模型能力不足，也不能给出归因百分比。需真实模型验收。

c. 渲染：mindmap-layout.ts:114 的历史修复已实际遍历子节点。artifact-renderer.ts:107 与 UI 共用布局；UI 默认 maxDepth=3 且 collapsedIds 为空，不会默认只剩一层。同一链路有层级输入就保留深度 3，排除“必然压平”。但当前 BFS 混用包含和横向关系，排序优先包含只在同一父节点内生效，存在跨分支抢父节点风险；需小范围衔接显式父子字段。course-merger.ts:92 对全部概念加根边目前会被布局 incoming 判定跳过，不是本夹具主因。

排序：a 为直接复现的首要缺陷；c 为关系歧义风险；b 待实测。无法从 mock 推算真实用户案例的贡献比例。
