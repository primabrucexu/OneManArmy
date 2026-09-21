# OneManArmy

OneManArmy 是直接运行在 Codex 中、从需求讨论开始工作的自动软件交付 Skill 套件。

用户只需从初始想法开始调用 `$oma-delivery`。它先把当前前台任务交给 `$oma-discuss`，持续保存多轮讨论、当前需求草稿和待决定事项；用户唯一一次确认后，再由 Runner 自动组织规划、独立审核、编码、返工和终态交付。

## 当前状态

Skill + Runner 架构已经完成真实可行性验证：

- Codex App Server 能发现仓库级 Skills，并通过原生 `skill` 输入调用指定 Skill。
- `$oma-discuss` 能将多轮讨论、最新需求草稿和冻结需求持久化到同一个 run 目录。
- Runner 能持久化状态、在独立线程中执行阶段 Skill，并根据结构化结果推进或返工。
- 真实验证经历了“规划 → 审核退回 → 重新规划 → 审核通过 → 编码 → 代码审核通过”。
- 六次真实调用使用六个独立线程，全程没有人工确认请求。
- 规划和审核阶段只读，只有编码阶段允许修改目标工作区。
- Runner 的正常完成、自动返工、中断恢复和失败终止测试均已通过。

当前实现是经过验证的架构基线，还不是完整生产版本。超时、进程异常、取消、重试分类、权限契约和真实大型仓库交付仍需继续完善。

## 安装与验证

需要 Node.js 18 或更高版本，并已在本机登录 Codex。

克隆仓库后，先安装依赖并运行测试：

```powershell
npm install
npm test
```

在本仓库中启动 Codex 时，Codex 会直接发现 `.agents/skills/` 下的仓库级 Skills，不需要额外安装。

如果要在任意软件项目中使用 OneManArmy，请在 Codex 中调用 `$skill-installer`，从本仓库一次安装以下五个 Skill：

```text
$skill-installer 请从 https://github.com/primabrucexu/OneManArmy 安装 .agents/skills 下的 oma-delivery、oma-discuss、oma-plan、oma-code 和 oma-review
```

五个 Skill 必须一起安装；只安装 `$oma-delivery` 会缺少讨论、规划、编码或审核阶段。Codex 通常会自动发现新安装的 Skill；如果技能列表没有刷新，重启 Codex。安装与发现机制参见 [OpenAI Skills 文档](https://learn.chatgpt.com/docs/build-skills)。

## 日常使用

在 Codex 中打开要开发的目标项目，从第一句需求想法开始调用：

```text
$oma-delivery 我想讨论并实现一个需求……
```

之后像普通对话一样逐步补充目标、范围、非目标、验收标准和约束，不需要一次写完，也不需要手动调用 `$oma-discuss`：

```text
先解决批量导入，导出这次不做。
重复数据怎么处理还没决定，我们继续讨论这个。
```

讨论中断后，重新调用 `$oma-delivery` 即可继续。只有一个未完成讨论时会自动恢复；同时存在多个讨论时，它会根据保存的标题让用户选择，不会猜测。

确认需求前，可以随时修改或排除之前提出的内容。准备进入自动交付时，明确确认当前需求：

```text
确认，按当前需求执行。
```

确认前不会进入规划或修改产品代码；确认后需求被冻结，Runner 自动完成规划、独立审核、编码、返工和最终验收，不再把实现过程中的中间决策交回用户。`$oma-delivery` 是唯一正式入口，其他四个阶段 Skill 由流程内部调用。

讨论和执行状态保存在目标项目的 `.oma/runs/<requirement-id>/`，不依赖聊天窗口保留全部上下文：

- `discussion-state.json`：讨论状态和标题。
- `discussion.jsonl`：逐轮保存的完整讨论历史。
- `requirement-draft.md`：随讨论更新的当前需求草稿。
- `requirement.md`：用户确认后冻结的正式需求。
- `state.json`：自动交付阶段、返工轨迹和最终状态。

## 正式架构

```mermaid
flowchart TD
    A["$oma-delivery：唯一入口"] --> B["$oma-discuss：当前前台任务"]
    B --> C["逐轮保存 discussion.jsonl 与 requirement-draft.md"]
    C --> D{"用户唯一一次确认"}
    D -- "继续讨论" --> B
    D -- "确认" --> E["冻结 requirement.md"]
    E --> F["Runner：状态、循环、恢复、权限和终态"]

    F --> G["$oma-plan：制定或修正方案"]
    G --> H["$oma-review：独立方案审核"]
    H -- "revise" --> G
    H -- "completed" --> I["$oma-code：实现与验证"]
    I --> J["$oma-review：独立代码审核与最终验收"]
    J -- "revise" --> I
    J -- "completed" --> K["交付成功"]

    G -. "failed" .-> L["交付失败并保存证据"]
    H -. "failed" .-> L
    I -. "failed" .-> L
    J -. "failed" .-> L

    F <--> M["state.json：持久状态与执行轨迹"]
    F <--> N["Codex App Server：线程与 Skill 执行通道"]
```

### Skill 与 Runner 的边界

- `$oma-delivery` 是用户在 Codex 中调用的唯一正式入口。
- `$oma-delivery` 只判断当前阶段并把工作路由给对应 Skill，不讨论需求、制定方案、编码或审核。
- `$oma-discuss` 在当前用户任务中负责交互式需求讨论、逐轮持久化和确认冻结；它不能在后台子线程中等待用户。
- `$oma-plan`、`$oma-code` 和 `$oma-review` 负责确认后的专业工作。
- Runner 不代替 Agent 思考，只负责确认后的确定性状态转换、返工循环、重试上限、独立线程、权限隔离、持久化和终态。
- Codex App Server 是 Runner 调用阶段 Skill 的执行通道。
- `discussion-state.json`、`discussion.jsonl`、需求文档和 `state.json` 是恢复与审计依据；流程不能依赖模型记住上一次执行位置。
- 不提供绕过 Runner 的任意 Prompt 执行接口。

### 权限与终态

- 讨论阶段只允许写入当前 run 目录，不允许修改产品代码。
- 规划和审核线程使用只读权限。
- 只有编码线程可以修改目标工作区。
- Runner 以不请求人工批准的方式启动阶段线程。
- 超出已确认权限、超过返工上限或客观无法完成时，流程必须进入失败终态并保存证据。
- 讨论阶段允许等待用户继续输入；需求确认并启动 Runner 后，正式终态只有成功、失败和取消。

## 目录

```text
.agents/skills/
├── oma-discuss/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   └── scripts/
│       ├── discuss.mjs
│       └── discuss.test.mjs
├── oma-delivery/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   └── scripts/
│       ├── runner.mjs
│       └── runner.test.mjs
├── oma-plan/
│   └── SKILL.md
├── oma-code/
│   └── SKILL.md
└── oma-review/
    └── SKILL.md
```

## 核心规则

- 用户从第一句想法开始只调用 `$oma-delivery`。
- 每轮讨论都保存原始记录和最新结构化草稿。
- 讨论记录保留历史，正式需求只保留当前确认内容。
- 确认后的需求是不可变执行契约。
- 实现方案不得扩展或改变已确认的需求。
- 生产 Skill 与审核 Skill 使用独立线程。
- 审核结果只能推动通过、自动返工或失败终止。
- 自动修正不能通过降低验收标准获得通过。
- 无法完成时输出原因、证据和已完成工作，不返回人工确认流程。

## 当前差距与建设顺序

1. 完善讨论恢复：补齐并发需求选择、临时输入清理和真实跨任务恢复验证。
2. 完善 Runner：补齐取消、超时、进程异常、幂等、分类重试和权限契约。
3. 完善阶段 Skills：固定输入输出、上下文边界、最终验收和失败证据。
4. 验证真实交付：在受控真实仓库中无人值守完成需求、实现、测试、返工与交付。
5. 完善分发：整理为可安装、升级和移除的 Codex 插件或 Skill 包。
