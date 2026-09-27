# 注意事项

1. 每次改动完后，都必须 git commit 一次，以便后续追踪和回滚。
2. 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。

## 默认开发分工

涉及代码实现、修复或重构时，默认使用 [luna-assisted-development](.agents/skills/luna-assisted-development/SKILL.md) 技能。用户已授权主 Agent 负责架构、拆分、审查与集成，将独立且范围明确的基础编码任务派发给 `gpt-5.6-luna`，推理强度 `max`。

主 Agent 统一验证和提交；微小任务直接处理，模型不可用时说明限制并由主 Agent 接手。用户本次明确指定的分工优先。
