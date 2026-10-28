// Configured MCP server names from Claude Code config files. Only names are read; env values,
// URLs and commands (which may hold secrets) are never kept. No vscode dependency.
import * as fs from 'fs';
import * as path from 'path';

const MAX_CONFIG_BYTES = 64 * 1024 * 1024;

export interface ConfiguredServer {
  name: string;
  /** user = ~/.claude.json top level, local = ~/.claude.json projects[cwd], project = <cwd>/.mcp.json */
  scope: 'user' | 'local' | 'project';
  /** Project folder for local/project scope. */
  project?: string;
}

/** Tool names use the server name with characters outside [A-Za-z0-9_-] replaced by '_'. */
export function normalizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function serverNames(v: unknown): string[] {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.keys(v) : [];
}

async function readJson(file: string): Promise<unknown> {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return undefined;
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Servers from `claudeJson` (~/.claude.json) for the given project folders, plus their .mcp.json files. */
export async function readConfiguredServers(claudeJson: string, projects: string[]): Promise<ConfiguredServer[]> {
  const out: ConfiguredServer[] = [];
  const cfg = await readJson(claudeJson);
  if (typeof cfg === 'object' && cfg !== null) {
    const c = cfg as Record<string, unknown>;
    for (const name of serverNames(c.mcpServers)) out.push({ name, scope: 'user' });
    const proj = typeof c.projects === 'object' && c.projects !== null ? (c.projects as Record<string, unknown>) : {};
    for (const p of projects) {
      const entry = Object.prototype.hasOwnProperty.call(proj, p) ? proj[p] : undefined;
      if (typeof entry === 'object' && entry !== null) {
        for (const name of serverNames((entry as Record<string, unknown>).mcpServers)) out.push({ name, scope: 'local', project: p });
      }
    }
  }
  for (const p of projects) {
    const mcp = await readJson(path.join(p, '.mcp.json'));
    if (typeof mcp === 'object' && mcp !== null) {
      for (const name of serverNames((mcp as Record<string, unknown>).mcpServers)) out.push({ name, scope: 'project', project: p });
    }
  }
  return out;
}

/** Configured servers that were never called (by normalised name) in `usedServers`. */
export function unusedServers(configured: ConfiguredServer[], usedServers: Iterable<string>): ConfiguredServer[] {
  const used = new Set([...usedServers].map(normalizeServerName));
  const seen = new Set<string>();
  return configured.filter((c) => {
    const key = `${c.scope}|${c.project ?? ''}|${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !used.has(normalizeServerName(c.name));
  });
}
