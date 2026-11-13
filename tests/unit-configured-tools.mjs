import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configuredToolNames } from "../src/configured-tools.js";

const names = (defaultTools, allTools = []) => [...configuredToolNames(defaultTools, allTools)].sort();

describe("configuredToolNames", () => {
	it("uses pi's default tools when defaultTools is unset", () => {
		assert.deepEqual(names(undefined), ["bash", "edit", "read", "write"]);
	});

	it("applies +name and -name to the defaults", () => {
		assert.deepEqual(names(["+codemode", "-write"]), ["bash", "codemode", "edit", "read"]);
		assert.deepEqual(names(["+codemode", "-codemode"]), ["bash", "edit", "read", "write"]);
	});

	it("lets plain names replace the defaults", () => {
		assert.deepEqual(names(["read", "codemode", "+tool_search"]), ["codemode", "read", "tool_search"]);
		assert.deepEqual(names([]), []);
	});

	it("adds only MCP tools with direct exposure", () => {
		const allTools = [
			{ name: "mcp__github__search_code", exposure: "direct" },
			{ name: "mcp__github__get_issue", exposure: "deferred" },
			{ name: "mcp__notion__search", exposure: "codemode" },
			{ name: "agent", exposure: "direct" },
		];
		assert.deepEqual(names(["+codemode"], allTools), ["bash", "codemode", "edit", "mcp__github__search_code", "read", "write"]);
	});
});
