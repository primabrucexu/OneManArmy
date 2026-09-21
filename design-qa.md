# F001 Design QA

## Evidence

- Source visual truth: `docs/feature/assets/F001-requirement-discussion-ui.png`
- Implementation screenshot: `implementation-requirement-discussion.png`
- Additional state screenshot: `implementation-f-document.png`
- Responsive evidence: `implementation-requirement-discussion-narrow.png`
- Workbench interaction evidence: `implementation-workbench.png`
- Read-only settings evidence: `implementation-settings.png`
- Source pixels: 1488 × 1056
- Implementation pixels: 1488 × 1056
- CSS viewport: 1488 × 1056
- Device scale factor: 1
- Density normalization: none required; source and implementation use the same pixel dimensions.
- State: desktop light theme, requirement discussion active, populated real Codex response, requirement document v0.1, confirmation disabled because independent review is not connected.

## Full-view comparison

The final browser capture was compared with the source visual in one combined comparison at the same 1488 × 1056 size. The fixed 100px sidebar, project context, three-stage rail, tabbed workspace, persistent review column, independently scrolling discussion area, fixed composer and disabled confirmation action align with the source composition.

The source contains example content, a paperclip and a simulated independent reviewer. F001 explicitly excludes attachments and an independent review Agent, so the implementation intentionally omits the paperclip and displays the truthful `尚未接入` review state instead of reproducing those example facts.

## Focused-region comparison

Separate focused crops were not required because the native-resolution comparison keeps the chat, tab, review and composer text legible. The requirement document state was captured separately because the source only shows its tab, not its body.

## Required fidelity surfaces

- Fonts and typography: system Chinese sans-serif stack matches the source's neutral product type; heading, body, metadata and badge hierarchy remain distinct and readable.
- Spacing and layout rhythm: major tracks, margins and card proportions match. The review column was corrected from 320px to 335px and the composer was corrected from approximately 76px to 60px during iteration.
- Colors and visual tokens: cool white background, blue active states, pale blue Agent surfaces, orange review badge and green draft/local states match the source language without gradients.
- Image and asset fidelity: the screen has no illustrative or photographic assets. Standard interface icons use the locally bundled Phosphor icon library; no handcrafted SVG, emoji or placeholder icon shapes are used.
- Copy and content: all product copy reflects F001. Example project data from the source is replaced by live project configuration, and unsupported audit capability is not presented as working.

## Interaction and browser verification

- Verified discussion and requirement document tab switching.
- Verified unsent input survives tab switching.
- Verified a real first Codex turn produces an Agent reply, requirement document and decision list.
- Verified a second message resumes the same thread and advances the document revision.
- Verified the requirement document renders goal, scope, non-goals, behaviors and acceptance criteria.
- Verified the confirmation action stays disabled while independent review is unavailable.
- Verified 1024 × 768 narrow-desktop behavior without hiding the main composer.
- Verified the app defaults to the workbench and the project card enters requirement discussion.
- Verified sidebar workbench/settings navigation, top return action and breadcrumb return action.
- Verified browser back/forward navigation across workbench, requirement discussion and settings.
- Verified unsent discussion input survives view navigation and browser history traversal.
- Browser console warnings/errors: none in the final run.

## Comparison history

### Iteration 1

- [P2] The review column measured 320px instead of the source's approximately 335px.
- [P2] The composer rendered approximately 16px taller than the source, reducing visible conversation space.
- Fixes: changed the review track to 335px, fixed the textarea height to 60px and widened the tab targets to match the source rhythm.
- Post-fix evidence: `implementation-requirement-discussion.png`.

### Iteration 2

- [P2] Standard navigation and action icons present in the source were absent.
- Fix: bundled Phosphor Icons locally and added consistent outline icons to navigation, tabs, back action, send action and disabled confirmation action.
- Post-fix evidence: `implementation-requirement-discussion.png`; browser inspection confirmed seven icon glyphs and no console errors.

### Interaction regression fix

- The original sidebar and return affordances were static elements even though they looked actionable.
- Fix: added hash-based application navigation, a real workbench project entry, a real read-only settings view, functional sidebar/top/breadcrumb navigation and browser history support.
- Post-fix evidence: `implementation-workbench.png` and `implementation-settings.png`; browser verification confirmed route changes and draft preservation.

## Findings

No actionable P0, P1 or P2 findings remain.

## Follow-up polish

- [P3] Live conversation length naturally differs from the source's illustrative five-message sample; the scrollable layout preserves the same density as more messages accumulate.

## Implementation checklist

- [x] Desktop reference composition matched.
- [x] Core discussion and document interactions verified.
- [x] Real Codex response and thread continuation verified.
- [x] Browser console checked.
- [x] P0, P1 and P2 findings resolved.

final result: passed

## F002 interaction extension

- 在聊天工作区左侧加入固定宽度的项目内历史栏，保持全局侧边栏、当前工作区和审核栏的层级关系。
- 验证两条独立对话的标题、倒序排列、选中态和待决策状态。
- 验证切换对话时消息、需求文档、待决策项和未发送草稿相互隔离。
- 验证页面刷新与本地服务重启后，恢复上次选中的对话、需求文档版本和输入草稿。
- 验证 Agent 响应期间新建与历史切换不可用；最终浏览器控制台错误为 0。
