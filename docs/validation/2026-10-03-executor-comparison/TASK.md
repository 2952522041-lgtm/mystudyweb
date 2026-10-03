# Task: readable paragraph differences for course history

Implement two small connected improvements for a Chinese React/TypeScript PDF learning app: a bounded paragraph diff, and a standalone accessible UI to read changes without rendering an unbounded list. The main agent will integrate your component into the existing history screen.

You work only inside this task directory. Do not inspect sibling task directories, the application repository, personal settings, credentials or other projects. The provided node_modules symlink is read-only dependencies. Do not install packages, use network tools, modify tool permissions, commit or publish. Do not delegate. You have 10 minutes for the initial attempt. Existing authentication is managed by your harness, not by your code.

Allowed edits: lib/summary-diff.ts, components/summary-diff-view.tsx, tests/summary-diff.test.ts, additional tests/summary-diff*.test.ts or tests/summary-diff*.fixture.tsx. Temporary test bundles may go in .test-output/. Do not change TASK.md, package.json, tsconfig.json, .oxlintrc.json or node_modules. Add meaningful tests. Preserve the supplied public tests; append to them.

## Part A: pure TypeScript algorithm

Implement the exact exports already declared in lib/summary-diff.ts. No runtime dependencies.

- Normalize CRLF and lone CR to LF. Outside fenced code and display math, one or more whitespace-only lines separate paragraphs. Trim the outer whitespace of each resulting paragraph; omit empty paragraphs. Keep interior line breaks and spaces unchanged.
- Fenced code blocks: a line with up to 3 leading spaces and at least 3 backticks or tildes opens a fence; a closing fence must use the same character, at least the opening length, and only trailing whitespace. Opening backtick info strings must not contain a backtick. Blank lines inside a fence never split a paragraph. Preserve unclosed fences to EOF. A fence without surrounding blank lines remains in the surrounding paragraph.
- Display math: a line whose trimmed text is exactly $$ toggles a math block outside code; blank lines inside it never split a paragraph. Code fences inside math do not toggle code state, and $$ inside code does not toggle math. Preserve unclosed math to EOF.
- Diff returns one segment per paragraph in stable source order; equal/removed reconstruct before, equal/added reconstruct after. Match exact normalized paragraphs with a longest common subsequence (LCS). For equal-length LCS alternatives, remove from before first. A replacement is removed then added. Counts count paragraphs, not characters.
- Strip shared prefix/suffix before allocating an LCS matrix. MAX_DIFF_CELLS is 40_000. If the product of the remaining lengths is greater than that, use a bounded fallback: preserve the equal prefix/suffix, remove the entire before middle then add the entire after middle, set coarse=true. Otherwise coarse=false. Never discard content. Large identical summaries must remain all equal with coarse=false. The matrix must be bounded by this policy.

## Part B: standalone React UI

Export SummaryDiffView({before, after, beforeLabel?, afterLabel?}). Default labels: 起始版本, 对比版本. Use only React and the pure helper, with relative imports; native buttons/checkbox are sufficient. Tailwind is available in the final app, no new CSS file required.

- Accessible section named 总结文字差异. Show supplied version labels and counts 新增 N 段 · 移除 M 段 · 未变 K 段.
- Checkbox named 只看改动, checked initially. It hides equal segments but preserves change order. Native keyboard interaction must work.
- Render at most 20 paragraph rows initially, with a native 显示更多 button that reveals 20 more rows per click, disappearing once all filtered rows are visible. A row has data-diff-kind equal/added/removed and a child with data-diff-text containing the exact paragraph text. Include visible labels 未变/新增/移除; color alone is insufficient.
- When before or after changes, reset the checkbox to checked and the limit to 20. Changing only labels must preserve controls. Toggling the checkbox also resets the limit to 20.
- Both empty: 没有可比较的总结文字。; equal nonempty summaries: 总结文字没有变化。; coarse: 内容较长，显示简化差异。 Display these truthfully.
- Show paragraph content as escaped plain text, preserving line breaks. Never execute/render source HTML or links. Wrap long lines for narrow windows, provide sensible Chinese labels and visible keyboard focus.
- Do not call AI or write storage. No automatic restore/edit action.

## Verification and report

Run: node --test --experimental-strip-types tests/summary-diff*.test.ts
Run: node node_modules/typescript/bin/tsc --noEmit
Run: node_modules/.bin/oxlint lib components tests

Node cannot import TSX directly. If adding UI tests, esbuild is available to bundle a TSX fixture under .test-output/; React and react-dom/server are available. Real browser interaction will also be checked independently by the main agent. Do not claim it passed unless you ran it.

Finish with changed files, actual commands/results, remaining issues. Correctness, meaningful coverage, bounded work, accessible UI and staying within scope matter more than minimal code length.
