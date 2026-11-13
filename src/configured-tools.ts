// Tools pi's config turns on for every session. With native system updates the
// bridge declares these to Claude from the first request and defers the rest
// behind ToolSearch: a configured tool is the same in every request, so loading
// it keeps the cached prefix, and a tool that switches on mid-session (agent,
// tool_search loads) stays out of the prefix.

// Mirrors pi's settings-manager, which does not export these.
const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"];

const isModifier = (entry: string) => entry.startsWith("+") || entry.startsWith("-");

/** The `defaultTools` setting resolved as pi resolves it at startup. */
function resolveDefaultTools(setting: unknown): string[] {
	if (setting === undefined) return DEFAULT_TOOL_NAMES;
	const entries = Array.isArray(setting) ? setting.filter((entry): entry is string => typeof entry === "string") : [];
	const plain = entries.filter((entry) => !isModifier(entry));
	const tools = [...(plain.length > 0 || entries.length === 0 ? plain : DEFAULT_TOOL_NAMES)];
	for (const entry of entries) {
		if (!isModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}

/** `defaultTools` (codemode and tool_search included when it names them) plus
 *  MCP tools whose server or `toolExposure` config makes them `direct`. */
export function configuredToolNames(defaultTools: unknown, allTools: readonly { name: string; exposure?: string }[]): Set<string> {
	const names = new Set(resolveDefaultTools(defaultTools));
	for (const tool of allTools) if (tool.name.startsWith("mcp__") && tool.exposure === "direct") names.add(tool.name);
	return names;
}
