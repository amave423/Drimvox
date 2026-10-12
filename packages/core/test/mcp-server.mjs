// A real MCP server over stdio for the tests: two tools, and one that reports what it was started with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.registerTool("echo", { description: "Repeats the text", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));

server.registerTool("add", { description: "Adds two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

server.registerTool("secret", { description: "Tells whether DEMO_TOKEN was given", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: process.env.DEMO_TOKEN ? `token length ${process.env.DEMO_TOKEN.length}` : "no token" }],
}));

await server.connect(new StdioServerTransport());
