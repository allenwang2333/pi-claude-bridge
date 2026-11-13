import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { SystemUpdates } from "../src/system-updates.js";
import { buildSystemPrompt, buildSystemPromptState } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { activateWithMockPi } from "./lib/mock-pi.mjs";
import { __test } from "../src/index.js";

async function listTools(server) {
	let reply;
	const transport = { start: async () => {}, close: async () => {}, send: async (message) => { if (message.id === 1) reply = message; } };
	await server.instance.connect(transport);
	await transport.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
	// The protocol handler runs asynchronously.
	while (!reply) await new Promise((r) => setImmediate(r));
	return reply.result.tools;
}

describe("system update delivery", () => {
	it("delivers additions, changes and removals once, without mutating its input", () => {
		const source = { workflow: "on" };
		const updates = new SystemUpdates({}, source);
		source.workflow = "unexpected";
		assert.deepEqual(updates.sections, {});
		assert.match(updates.take(), /<workflow>\non\n<\/workflow>/);
		assert.equal(updates.take(), undefined);
		updates.update({ workflow: "changed", mcp_servers: "M" });
		assert.match(updates.take(), /changed/);
		updates.update({});
		assert.match(updates.take(), /Removed system prompt section "workflow"/);
		assert.equal(updates.take(), undefined);
	});

	it("keeps an undelivered update pending until a hook consumes it", () => {
		const updates = new SystemUpdates({ workflow: "old" });
		updates.update({ workflow: "new" });
		assert.deepEqual(updates.sections, { workflow: "old" });
		assert.match(updates.take(), /new/);
		assert.deepEqual(updates.sections, { workflow: "new" });
	});

	it("resets custom sections after a rebuild or fork, including an empty set", () => {
		const updates = new SystemUpdates({ workflow: "on" }, {}, true);
		assert.match(updates.take(), /All earlier custom system prompt sections are superseded/);
		assert.equal(updates.take(), undefined);
		const same = new SystemUpdates({ workflow: "on" }, { workflow: "on" }, true);
		assert.match(same.take(), /<workflow>\non\n<\/workflow>/);
	});
});

describe("native deferred provider", () => {
	after(() => __test.setQuery(null));
	it("keeps its preset append and CC session across on/off, loads configured tools and defers the rest", async () => {
		const handlers = activateWithMockPi();
		// Capture the provider from the pinned stream's test entry point.
		let provider;
		const { default: activate } = await import("../src/index.js");
		delete globalThis[Symbol.for("claude-bridge:activeStreamSimple")];
		activate({ on: () => {}, registerProvider: (_name, value) => { provider = value; },
			getSettings: () => ({ defaultTools: ["+codemode"] }), getAllTools: () => [] });
		const model = provider.models[0];
		const sid = "native-deferred-unit";
		__test.resetSharedSession(sid);
		const calls = [];
		__test.setQuery(({ prompt, options }) => {
			const sessionId = options.sessionId ?? options.resume;
			const call = { sessionId, options };
			calls.push(call);
			const stream = (async function* () {
				call.tools = await listTools(options.mcpServers["custom-tools"]);
				const input = (await prompt[Symbol.asyncIterator]().next()).value;
				const hook = options.hooks?.UserPromptSubmit?.[0].hooks[0];
				call.context = (await hook?.({ hook_event_name: "UserPromptSubmit" }, undefined, {}))?.hookSpecificOutput?.additionalContext;
				const builder = createSession({ projectPath: options.cwd, sessionId });
				builder.addUserMessage(input.message.content);
				builder.addAssistantMessage([{ type: "text", text: "ok" }]);
				const path = getSessionPath(sessionId, options.cwd, process.env.CLAUDE_CONFIG_DIR);
				mkdirSync(dirname(path), { recursive: true });
				for (const record of builder.records) appendFileSync(path, JSON.stringify(record) + "\n");
				yield { type: "system", subtype: "init", session_id: sessionId };
				yield { type: "user", isReplay: true, uuid: input.uuid, message: input.message, parent_tool_use_id: null };
				yield { type: "assistant", uuid: builder.records.at(-1).uuid, parent_tool_use_id: null,
					message: { id: `msg_${calls.length}`, model: model.id, content: [{ type: "text", text: "ok" }] } };
				yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId };
			})();
			stream.close = () => {};
			return stream;
		});

		const messages = [];
		let lastSections = {};
		let lastTools = [];
		const baseTool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
		for (const [label, sections, tools] of [
			["off", { mcp_servers: "M" }, [baseTool]],
			["on", { dynamic_workflow: "WORKERS ON", mcp_servers: "M" }, [baseTool, { ...baseTool, name: "agent" }]],
			["off again", { mcp_servers: "M" }, [baseTool]],
			["no tools", { mcp_servers: "M" }, []],
		]) {
			const opts = { cwd: "/tmp", contextFiles: [{ path: "/AGENTS.md", content: "KEEP THESE RULES" }], sections };
			handlers.get("before_agent_start")({ systemPrompt: buildSystemPrompt(opts), systemPromptOptions: opts });
			const state = buildSystemPromptState(opts);
			const patch = { ...state.sections };
			for (const key of Object.keys(lastSections)) if (!(key in patch)) patch[key] = null;
			messages.push({ role: "system", content: "", sections: patch, toolsAdded: tools, timestamp: 0 });
			messages.at(-1).toolsRemoved = lastTools.filter((tool) => !tools.some((current) => current.name === tool.name)).map(({ name }) => ({ name }));
			messages.push({ role: "user", content: label, timestamp: 0 });
			const reply = await provider.streamSimple(model, { messages }, { sessionId: sid }).result();
			assert.equal(reply.stopReason, "stop", reply.errorMessage);
			messages.push(reply);
			lastSections = state.sections;
			lastTools = tools;
		}
		assert.equal(new Set(calls.map((c) => c.sessionId)).size, 1, "no full import on on/off");
		assert.equal(new Set(calls.map((c) => c.options.systemPrompt.append)).size, 1);
		assert.match(calls[0].options.systemPrompt.append, /KEEP THESE RULES/);
		assert.doesNotMatch(calls[0].options.systemPrompt.append, /mcp_servers|dynamic_workflow/);
		assert.match(calls[0].context, /mcp_servers/);
		assert.match(calls[1].context, /WORKERS ON/);
		assert.match(calls[2].context, /Removed system prompt section "dynamic_workflow"/);
		for (const call of calls) {
			assert.deepEqual(call.options.tools, ["ToolSearch"]);
			assert.equal(call.options.env.ENABLE_TOOL_SEARCH, "true");
			assert.ok(call.tools.length);
			// read is a default tool; agent and the placeholder are not configured.
			for (const tool of call.tools) assert.equal(tool._meta?.["anthropic/alwaysLoad"], tool.name === "read", tool.name);
		}
		assert.ok(calls[1].tools.some((tool) => tool.name === "agent"));
		assert.ok(!calls[2].tools.some((tool) => tool.name === "agent"));
		assert.deepEqual(calls[3].tools.map((tool) => tool.name), ["__pi_deferred_placeholder__"]);
		assert.equal(calls[3].context, undefined, "unchanged sections are not injected again");
	});
});
