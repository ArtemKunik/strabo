# Agent skills

Two [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) that teach a coding
agent to use Strabo's MCP tools well. They ship in the `strabo-map` npm package.

| Skill | For |
| --- | --- |
| [`strabo-structural-coding`](strabo-structural-coding/SKILL.md) | refactors, moves, extractions, cycle breaking, and diagnosing a reported symptom from ranked candidates: look, simulate, edit, verify |
| [`strabo-review`](strabo-review/SKILL.md) | reviewing a change: scope it, triage the summary, separate new problems from old ones |

Both expect the `strabo` MCP server to be configured (see [docs/MCP.md](../docs/MCP.md)).

## Install

Copy the folders into a skills directory Claude Code reads:

```sh
# for one repository
cp -r node_modules/strabo-map/skills/strabo-* .claude/skills/
# for every repository on this machine
cp -r node_modules/strabo-map/skills/strabo-* ~/.claude/skills/
```

From a checkout, copy from `skills/` instead of `node_modules/strabo-map/skills/`.
