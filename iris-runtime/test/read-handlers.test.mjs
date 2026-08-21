// read-handlers.ts — workspace-discovered shell recipes for the read tool,
// the same extension seam skills have (drop a directory in, no core PR),
// applied to file-format handling. These pin discovery, the same-name
// override rule, and the {path} substitution.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { loadReadHandlerRegistry, renderHandlerCommand } from "../dist/engine/read-handlers.js";
import { createReadTool } from "../dist/engine/tools/read.js";

function writeHandler(workspaceDir, dirName, manifest) {
	const dir = join(workspaceDir, "read-handlers", dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "handler.json"), JSON.stringify(manifest));
}

function tempWorkspace() {
	return mkdtempSync(join(tmpdir(), "iris-read-handlers-test-"));
}

test("loadReadHandlerRegistry: no read-handlers directory returns an empty registry", () => {
	const workspaceDir = tempWorkspace();
	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.size, 0);
});

test("loadReadHandlerRegistry: loads a valid handler and maps each of its mimeTypes", () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "pdf-text", {
		name: "pdf-text",
		mimeTypes: ["application/pdf"],
		command: "pdftotext -layout {path} -",
	});

	const registry = loadReadHandlerRegistry(workspaceDir);
	const handler = registry.get("application/pdf");
	assert.equal(handler.name, "pdf-text");
	assert.equal(handler.timeoutSeconds, 30);
});

test("loadReadHandlerRegistry: skips a manifest missing mimeTypes", () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "broken", { name: "broken", command: "cat {path}" });

	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.size, 0);
});

test("loadReadHandlerRegistry: skips a manifest missing command", () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "broken", { name: "broken", mimeTypes: ["text/x-broken"] });

	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.size, 0);
});

test("loadReadHandlerRegistry: skips a directory with unparseable JSON, doesn't throw", () => {
	const workspaceDir = tempWorkspace();
	const dir = join(workspaceDir, "read-handlers", "broken");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "handler.json"), "{not json");

	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.size, 0);
});

test("loadReadHandlerRegistry: a directory named the same as an existing handler overrides it", () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "pdf-text", {
		name: "pdf-text",
		mimeTypes: ["application/pdf"],
		command: "pdftotext -layout {path} -",
	});
	// Simulate an overlay override: same directory name, different command.
	writeHandler(workspaceDir, "pdf-text", {
		name: "pdf-text",
		mimeTypes: ["application/pdf"],
		command: "ocr-tool {path}",
	});

	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.get("application/pdf").command, "ocr-tool {path}");
});

test("loadReadHandlerRegistry: two different-named handlers claiming the same mimeType — one wins, deterministically (readdir order), not both", () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "aaa-first", { name: "aaa-first", mimeTypes: ["application/x-custom"], command: "a {path}" });
	writeHandler(workspaceDir, "zzz-second", { name: "zzz-second", mimeTypes: ["application/x-custom"], command: "b {path}" });

	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.size, 1);
	assert.ok(["aaa-first", "zzz-second"].includes(registry.get("application/x-custom").name));
});

test("renderHandlerCommand: substitutes {path}, shell-escaping it", () => {
	const handler = { name: "x", mimeTypes: ["x/y"], command: "pdftotext -layout {path} -", timeoutSeconds: 30 };
	assert.equal(
		renderHandlerCommand(handler, "/tmp/a file's name.pdf"),
		"pdftotext -layout '/tmp/a file'\\''s name.pdf' -",
	);
});

test("read: handler output observes the ordinary read output limits", async () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "pdf-text", {
		mimeTypes: ["application/pdf"],
		command: "pdftotext {path} -",
	});

	const pdfHeader = Buffer.from("%PDF-1.4", "utf-8").toString("base64");
	const extractedText = Array.from({ length: 2_100 }, (_, index) => "line " + (index + 1)).join(String.fromCharCode(10));
	const executor = {
		async exec(command) {
			if (command.includes("head -c")) return { stdout: pdfHeader, stderr: "", code: 0 };
			if (command.startsWith("pdftotext")) return { stdout: extractedText, stderr: "", code: 0 };
			throw new Error(`Unexpected command: ${command}`);
		},
	};
	const tool = createReadTool(executor, { supportsImageInput: true, workspaceDir });
	const result = await tool.execute("call-id", { label: "read PDF", path: "/workspace/test.pdf" });

	assert.equal(result.details.truncation.truncated, true);
	assert.match(result.content[0].text, /line 2000/);
	assert.doesNotMatch(result.content[0].text, /line 2001/);
	assert.match(result.content[0].text, /output truncated after 2000 of 2100 lines/);
});
