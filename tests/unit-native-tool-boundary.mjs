// A native system update must reach CC after both successful and failed pi tools.
import { it, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { buildSystemPrompt, buildSystemPromptState } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { activateWithMockPi } from "./lib/mock-pi.mjs";
import { default as activate, __test } from "../src/index.js";

after(() => __test.setQuery(null));
for (const isError of [false, true]) it(`delivers custom sections after a ${isError ? "failed" : "successful"} tool`, async () => {
	const handlers = activateWithMockPi();
	let provider;
	delete globalThis[Symbol.for("claude-bridge:activeStreamSimple")];
	activate({ on: () => {}, registerProvider: (_name, value) => { provider = value; } });
	const model = provider.models[0];
	const sid = `native-boundary-${isError}`;
	__test.resetSharedSession(sid);
	const seen = [];
	__test.setQuery(({ prompt, options }) => {
		const sessionId = options.sessionId ?? options.resume;
		const path = getSessionPath(sessionId, options.cwd, process.env.CLAUDE_CONFIG_DIR);
		let parentUuid = null;
		const record = (role, content, uuid) => {
			const session = createSession({ projectPath: options.cwd, sessionId });
			if (role === "assistant") session.addAssistantMessage(content);
			else session.addUserMessage(content);
			const value = { ...session.records[0], ...(uuid ? { uuid } : {}), parentUuid };
			parentUuid = value.uuid;
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, JSON.stringify(value) + "\n");
			return value;
		};
		const stream = (async function* () {
			const input = (await prompt[Symbol.asyncIterator]().next()).value;
			record("user", input.message.content, input.uuid);
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "user", isReplay: true, uuid: input.uuid, message: input.message, parent_tool_use_id: null };
			await options.hooks.UserPromptSubmit[0].hooks[0]({}, undefined, {});
			const context = [...__test.activeQueryContexts].find((c) => c.piSessionId === sid);
			// Auto re-list the MCP server when pi widens the active set.
			const server = options.mcpServers["custom-tools"];
			const transport = { start: async () => {}, close: async () => {}, send: async (message) => {
				if (message.method === "notifications/tools/list_changed") transport.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
			} };
			await server.instance.connect(transport);
			let deliver;
			const delivered = new Promise((resolve) => { deliver = resolve; });
			context.dispatchedToolCalls.add("load");
			context.pendingToolCalls.set("load", { toolName: "loader", resolve: deliver });
			const call = [{ type: "tool_use", id: "load", name: "mcp__custom-tools__loader", input: {} }];
			const assistant = record("assistant", call);
			yield { type: "assistant", parent_tool_use_id: null, uuid: assistant.uuid,
				message: { id: "msg_load", model: model.id, content: call } };
			await delivered;
			const hookName = isError ? "PostToolUseFailure" : "PostToolUse";
			const result = await options.hooks[hookName][0].hooks[0]({}, undefined, {});
			seen.push(result.hookSpecificOutput?.additionalContext);
			assert.equal(context.systemUpdates.take(), undefined, "not repeated on the following hook");
			const tool = record("user", [{ type: "tool_result", tool_use_id: "load", content: "loaded", is_error: isError }]);
			yield { type: "user", parent_tool_use_id: null, uuid: tool.uuid, message: tool.message };
			const reply = record("assistant", [{ type: "text", text: "done" }]);
			yield { type: "assistant", parent_tool_use_id: null, uuid: reply.uuid,
				message: { id: "msg_done", model: model.id, content: reply.message.content } };
			yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: sessionId };
		})();
		stream.close = () => {};
		return stream;
	});

	const tool = { name: "loader", description: "Load", parameters: { type: "object", properties: {} } };
	const before = { cwd: "/tmp", sections: { workflow: "before" } };
	const capture = (opts) => handlers.get("before_agent_start")({ systemPrompt: buildSystemPrompt(opts), systemPromptOptions: opts });
	capture(before);
	const messages = [{ role: "system", ...buildSystemPromptState(before), toolsAdded: [tool], timestamp: 0 }, { role: "user", content: "load", timestamp: 0 }];
	const first = await provider.streamSimple(model, { messages }, { sessionId: sid }).result();
	assert.equal(first.stopReason, "toolUse", first.errorMessage);
	const next = { cwd: "/tmp", sections: { workflow: "AFTER TOOL" } };
	capture(next);
	messages.push(first, { role: "system", ...buildSystemPromptState(next), toolsAdded: [{ ...tool, name: "canary" }], timestamp: 0 },
		{ role: "toolResult", toolCallId: "load", toolName: "loader", content: [{ type: "text", text: "loaded" }], isError, timestamp: 0 });
	const answer = await provider.streamSimple(model, { messages }, { sessionId: sid }).result();
	assert.equal(answer.stopReason, "stop", answer.errorMessage);
	assert.equal(seen.length, 1);
	assert.match(seen[0], /AFTER TOOL/);
});
