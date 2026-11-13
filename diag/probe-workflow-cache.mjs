#!/usr/bin/env node
// Paid end-to-end cache probe with real pi, this bridge and /dynamic-workflow.
// Start diag/capture-proxy.mjs on 18879 first, then:
// node --import tsx diag/probe-workflow-cache.mjs /path/to/warehouse/extensions/index.ts
// PROBE_CAPTURE_DIR overrides the capture directory; artifacts stay under /tmp.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { createRpcHarness } from "../tests/lib/rpc-harness.mjs";

const extension = process.argv[2];
assert.ok(extension, "pass the warehouse extension's index.ts path");
const captureDir = process.env.PROBE_CAPTURE_DIR ?? "/tmp/pi-native-deferred-capture";
const rows = () => existsSync(`${captureDir}/index.jsonl`)
	? readFileSync(`${captureDir}/index.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const start = rows().length;
const out = `/tmp/pi-workflow-cache-${Date.now()}`;
mkdirSync(out, { recursive: true });
process.env.CLAUDE_BRIDGE_TEST_LOG_DIR = out;
const args = ["--model", process.env.PROBE_MODEL ?? "claude-bridge/claude-haiku-5-5", "-e", extension, "--session", `${out}/pi.jsonl`];
const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:18879", _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" };
const harness = createRpcHarness({ name: "workflow", args, env, persistSession: true, defaultTimeout: 90_000,
	...(process.env.PROBE_BRIDGE_DIR ? { bridgeDir: process.env.PROBE_BRIDGE_DIR } : {}),
});
await harness.startAndWait();
try {
	for (const [label, prompt] of [
		["seed", "Reply only OK. Do not use tools."],
		["control", "Reply only OK. Do not use tools."],
		["enable", "/dynamic-workflow Reply only OK. Do not launch workers or use tools."],
		["load tool", "Use the read tool to read only the first two lines of README.md. Do not launch workers. Then reply only READ."],
	]) {
		const reply = await harness.promptAndWait(prompt);
		assert.ok(reply, `${label}: empty reply`);
		console.log(label, JSON.stringify(reply));
	}
	await harness.send({ type: "prompt", message: "/dynamic-workflow off" });
	console.log("disable", JSON.stringify(await harness.promptAndWait("Reply only OFF. Do not use tools.")));
	console.log("followup", JSON.stringify(await harness.promptAndWait("Reply only OK. Do not use tools.")));
	// Restart pi against its own persisted session, not a fabricated CC transcript.
	const exited = once(harness.pi(), "exit");
	await harness.stop();
	await exited;
	await harness.startAndWait();
	console.log("restart", JSON.stringify(await harness.promptAndWait("Reply only RESUMED. Do not use tools.")));
} finally {
	const exited = once(harness.pi(), "exit");
	await harness.stop();
	await exited;
	console.log("artifacts", out);
}

const captured = rows().slice(start).filter((row) => row.status === 200 && row.usage);
assert.ok(captured.length >= 8, "all stages must reach Anthropic");
const requests = captured.map((row) => JSON.parse(readFileSync(`${captureDir}/req-${String(row.n).padStart(4, "0")}.json`, "utf8")));
const preset = (request) => request.system.filter((block) => !block.text?.startsWith("x-anthropic-billing-header:")).map((block) => block.text);
const removeCacheControl = (key, value) => key === "cache_control" ? undefined : value;
const activeTools = (request) => JSON.parse(JSON.stringify(request.tools.filter((tool) => !tool.defer_loading), removeCacheControl));
for (const request of requests.slice(1)) {
	assert.deepEqual(preset(request), preset(requests[0]), "leading system prompt must not change");
	assert.deepEqual(activeTools(request), activeTools(requests[0]), "non-deferred schemas must not change");
}
for (const row of captured.slice(2)) {
	assert.ok(row.usage.cacheRead >= captured[1].usage.cacheRead, `request ${row.n} lost the warm prefix`);
}
const blocks = (message) => typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join("\n");
assert.ok(requests.some((r) => r.messages.some((m) => m.role === "system" && blocks(m).includes('Updated system prompt section "dynamic_workflow"'))), "workflow instructions must reach a native system message");
assert.ok(requests.some((r) => r.tools.some((tool) => tool.name === "mcp__custom-tools__read" && tool.defer_loading)), "read must be native-deferred");
const debug = readFileSync(harness.DEBUG_LOG, "utf8");
assert.doesNotMatch(debug, /prompt-capture: no match|system prompt append changed|clean end left messages unrecorded/);
console.log("PASS: stable preset and direct schemas; native system updates; cache reads retained across on/off, tool loading and restart.");
console.log(captured.map((r) => ({ request: r.n, ...r.usage })));
