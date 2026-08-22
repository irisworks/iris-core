// read-handlers.ts — workspace-discovered shell recipes for the read tool,
// the same extension seam skills have (drop a directory in, no core PR),
// applied to file-format handling. These pin discovery, the same-name
// override rule, and the {path} substitution.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

test("loadReadHandlerRegistry: discovers a handler installed as a symlinked directory, like an overlay would", () => {
	const workspaceDir = tempWorkspace();
	const realHandlerDir = mkdtempSync(join(tmpdir(), "iris-overlay-handler-"));
	writeFileSync(
		join(realHandlerDir, "handler.json"),
		JSON.stringify({ name: "docx-text", mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], command: "docx2txt {path}" }),
	);
	mkdirSync(join(workspaceDir, "read-handlers"), { recursive: true });
	symlinkSync(realHandlerDir, join(workspaceDir, "read-handlers", "docx-text"), "dir");

	const registry = loadReadHandlerRegistry(workspaceDir);
	const handler = registry.get("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
	assert.equal(handler?.name, "docx-text");
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
	assert.match(result.content[0].text, /showing lines 1-2000 of 2100. Use offset=2001 to continue/);
});

test("read: handler output honors offset/limit like the plain-text read path", async () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "pdf-text", {
		mimeTypes: ["application/pdf"],
		command: "pdftotext {path} -",
	});

	const pdfHeader = Buffer.from("%PDF-1.4", "utf-8").toString("base64");
	const extractedText = Array.from({ length: 10 }, (_, index) => "line " + (index + 1)).join(String.fromCharCode(10));
	const executor = {
		async exec(command) {
			if (command.includes("head -c")) return { stdout: pdfHeader, stderr: "", code: 0 };
			if (command.startsWith("pdftotext")) return { stdout: extractedText, stderr: "", code: 0 };
			throw new Error(`Unexpected command: ${command}`);
		},
	};
	const tool = createReadTool(executor, { supportsImageInput: true, workspaceDir });
	const result = await tool.execute("call-id", { label: "read PDF", path: "/workspace/test.pdf", offset: 3, limit: 2 });

	assert.match(result.content[0].text, /^line 3\nline 4/);
	assert.doesNotMatch(result.content[0].text, /line 2\n/);
	assert.match(result.content[0].text, /Use offset=5 to continue/);
});

test("read: a handler claiming an image mimeType is ignored — the built-in image path still handles it", async () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "sneaky", {
		mimeTypes: ["image/png"],
		command: "echo hijacked",
	});

	// A real (1x1 transparent) PNG — file-type needs a valid chunk structure, not just the
	// 8-byte signature, to recognize the format.
	const realPng =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAAA8HzMPQAAAAtJREFUeJxjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=";
	const pngHeader = realPng;
	const pngBytes = realPng;
	const executor = {
		async exec(command) {
			if (command.includes("head -c")) return { stdout: pngHeader, stderr: "", code: 0 };
			if (command.startsWith("cat")) return { stdout: pngBytes, stderr: "", code: 0 };
			throw new Error(`Unexpected command: ${command}`);
		},
	};
	const tool = createReadTool(executor, { supportsImageInput: true, workspaceDir });
	const result = await tool.execute("call-id", { label: "read image", path: "/workspace/test.png" });

	assert.ok(result.content.some((c) => c.type === "image"));
});

test("loadReadHandlerRegistry: a handler claiming an image mimeType is dropped without overridesBuiltinImageHandling", () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "sneaky", { mimeTypes: ["image/png"], command: "echo hijacked" });

	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.get("image/png"), undefined);
});

test("loadReadHandlerRegistry: overridesBuiltinImageHandling: true lets a handler claim an image mimeType", () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "ocr", {
		name: "ocr",
		mimeTypes: ["image/png"],
		command: "ocr-tool {path}",
		overridesBuiltinImageHandling: true,
	});

	const registry = loadReadHandlerRegistry(workspaceDir);
	assert.equal(registry.get("image/png")?.name, "ocr");
});

test("read: a handler with overridesBuiltinImageHandling: true takes over image reads", async () => {
	const workspaceDir = tempWorkspace();
	writeHandler(workspaceDir, "ocr", {
		mimeTypes: ["image/png"],
		command: "ocr-tool {path}",
		overridesBuiltinImageHandling: true,
	});

	const realPng =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAAA8HzMPQAAAAtJREFUeJxjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=";
	const executor = {
		async exec(command) {
			if (command.includes("head -c")) return { stdout: realPng, stderr: "", code: 0 };
			if (command.startsWith("ocr-tool")) return { stdout: "recognized text", stderr: "", code: 0 };
			throw new Error(`Unexpected command: ${command}`);
		},
	};
	const tool = createReadTool(executor, { supportsImageInput: true, workspaceDir });
	const result = await tool.execute("call-id", { label: "read image", path: "/workspace/test.png" });

	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, "text");
	assert.match(result.content[0].text, /recognized text/);
});
