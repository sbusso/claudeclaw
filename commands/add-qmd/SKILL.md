---
name: add-qmd
description: Add QMD (Query Markup Documents) as an advanced memory search backend. Upgrades the built-in grep-based memory_search with hybrid BM25 + vector semantic search + LLM re-ranking. Fully local, no API keys needed. Triggers on "add qmd", "qmd memory", "semantic memory search", "upgrade memory".
---

# Add QMD Memory Backend

QMD (https://github.com/tobi/qmd) is a local search engine for markdown files. It combines BM25 keyword search, vector semantic search, and LLM re-ranking — all running on-device via node-llama-cpp with GGUF models.

This skill upgrades MotherClaw's built-in grep-based `memory_search` MCP tool with QMD's hybrid search, giving agents much better recall across large memory collections.

## Prerequisites

- MotherClaw with memory tools already working (memory_search, memory_save, memory_get)
- ~2GB disk space for GGUF embedding + reranking models (downloaded on first run)
- Node.js 20+

## What This Skill Does

1. Installs QMD as an MCP server dependency
2. Configures QMD to index all group memory directories (`groups/*/memory/`, `groups/*/CLAUDE.md`, `groups/*/conversations/`)
3. Replaces the grep-based `memory_search` in `agent/runner/src/ipc-mcp-stdio.ts` with QMD's API
4. Adds QMD indexing to the agent startup flow (incremental re-index on each run)

## Implementation Notes

### QMD MCP Server

QMD exposes its search as an MCP server. Add to the agent runner's `mcpServers` config:

```typescript
qmd: {
  command: 'npx',
  args: ['qmd', 'mcp', '--collection', collectionPath],
  env: {},
}
```

### Indexing

QMD indexes markdown files into a local SQLite database. The collection should be configured per-group:

```bash
# Index a group's memory
qmd index --collection groups/{folder}/.qmd groups/{folder}/memory/ groups/{folder}/CLAUDE.md groups/{folder}/conversations/
```

### Search Integration

Replace the grep-based `memory_search` tool body with a call to QMD's MCP:

```typescript
// Before (grep-based):
const results = grepFiles(args.query, allFiles);

// After (QMD):
// Use the qmd MCP server's search tool
// Returns semantically ranked results with relevance scores
```

### Fallback

If QMD is not installed or indexing fails, fall back to the built-in grep-based search. This ensures memory tools always work even without QMD.

## Not Implemented Yet

This skill is a specification for future implementation. The built-in grep-based memory tools work without QMD. Run this skill when you want to upgrade to semantic search.
