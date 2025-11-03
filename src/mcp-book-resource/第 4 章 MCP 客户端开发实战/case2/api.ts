import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";
import fs from "fs/promises";
import path from "path";

export async function POST(req: Request) {
  const { query } = await req.json();

  const mcpPrompt = await fs.readFile(
    path.join(process.cwd(), "./prompt.txt"),
    "utf-8"
  );

  const config = await fs.readFile(
    path.join(process.cwd(), "./mcp.json"),
    "utf-8"
  );

  const mcpServers = await getMcpServers(config);
  const mcpTools = await getMcpTools(mcpServers);

  const filterTools = ["rewrite_query", "google_search", "jina_reader"];
  const filteredTools = mcpTools.filter((tool) =>
    filterTools.includes(tool.name)
  );

  let contextMessages: MixContent[] = [];
  let toolResults = "";
  let reply = "";

  // loop for max 10 times
  for (let i = 0; i < 10; i++) {
    // pick tool
    const pickToolResult = await chatWithLLM({
      mcpPrompt,
      query,
      contextMessages: JSON.stringify(contextMessages),
      tools: JSON.stringify(filteredTools),
      toolResults: toolResults,
    });

    // parse content
    let content = "";
    for await (const chunk of pickToolResult.textStream) {
      content += chunk;
    }
    const mixContents = parseMixContents(content);
    contextMessages.push(...mixContents);
    reply += content;

    // parse tool
    let callToolParams = null;
    for (const mixContent of mixContents) {
      if (mixContent.type === "tool") {
        const tool = mixContent.tool;
        if (
          tool &&
          tool.tool_name &&
          tool.server_name &&
          mcpServers[tool.server_name] &&
          mcpServers[tool.server_name].command
        ) {
          callToolParams = {
            command: mcpServers[tool.server_name].command,
            args: mcpServers[tool.server_name].args || [],
            env: mcpServers[tool.server_name].env || {},
            name: tool.tool_name,
            params: tool.tool_params,
          };
          break;
        }
      }
    }

    // need to call tool
    if (callToolParams) {
      const callToolResult = await callTool(callToolParams);
      toolResults = JSON.stringify(callToolResult);

      reply += `\n\n${toolResults}\n\n`;

      continue;
    }

    // no need to call tool, end loop
    break;
  }

  return new Response(reply);
}

interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpTool {
  server_name: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MixContent {
  type: "text" | "tool";
  text?: string;
  tool?: {
    server_name: string;
    tool_name: string;
    tool_params?: Record<string, unknown>;
  };
}

async function getMcpServers(
  config: string
): Promise<Record<string, McpServer>> {
  const mcpConfig = JSON.parse(config);

  const mcpServers = Object.entries(mcpConfig.mcpServers).reduce(
    (acc, [key, value]) => {
      acc[key] = {
        name: key,
        command: (value as any).command,
        args: (value as any).args,
        env: (value as any).env,
      };
      return acc;
    },
    {} as Record<string, McpServer>
  );

  return mcpServers;
}

async function getMcpTools(
  mcpServers: Record<string, McpServer>
): Promise<McpTool[]> {
  const allTools = await Promise.all(
    Object.entries(mcpServers).map(async ([name, server]) => {
      const tools = await listTools({
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      });

      return tools.tools.map((tool) => ({
        server_name: name,
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema,
      }));
    })
  );

  return allTools.flat();
}

async function chatWithLLM({
  query,
  contextMessages,
  tools,
  toolResults,
  mcpPrompt,
}: {
  query: string;
  contextMessages?: string;
  tools?: string;
  toolResults?: string;
  mcpPrompt: string;
}) {
  const prompt = mcpPrompt
    .replace("{USER_QUERY}", query)
    .replace("{CONTEXT_MESSAGES}", contextMessages || "")
    .replace("{AVAILABLE_TOOLS}", tools || "")
    .replace("{PREVIOUS_TOOL_RESULTS}", toolResults || "");

  const result = await streamText({
    model: openrouter("anthropic/claude-3.5-sonnet"),
    prompt,
  });

  return result;
}

function parseMixContents(input: string): MixContent[] {
  const result: MixContent[] = [];
  const regex = /<<tool-start>>\s*([\s\S]*?)\s*<<tool-end>>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    // 前面的文本
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index).trim();
      if (text) {
        result.push({ type: "text", text });
      }
    }
    // tool 块
    const toolJson = match[1].trim();
    try {
      const tool = JSON.parse(toolJson);
      result.push({ type: "tool", tool });
    } catch (e) {
      // 解析失败可忽略或抛出
    }
    lastIndex = regex.lastIndex;
  }
  // 剩余文本
  if (lastIndex < input.length) {
    const text = input.slice(lastIndex).trim();
    if (text) {
      result.push({ type: "text", text });
    }
  }

  return result;
}

async function listTools({
  command,
  args,
  env = {},
}: {
  command: string;
  args: string[];
  env?: Record<string, string>;
}) {
  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...(process.env as Record<string, string>),
      ...env,
    },
  });

  const client = new Client({
    name: "search-agent",
    version: "1.0.0",
  });

  await client.connect(transport);

  const tools = await client.listTools();

  return tools;
}

async function callTool({
  command,
  args,
  env = {},
  name,
  params,
}: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  name: string;
  params?: Record<string, unknown>;
}) {
  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...(process.env as Record<string, string>),
      ...env,
    },
  });

  const client = new Client({
    name: "chatmcp",
    version: "1.0.0",
  });

  await client.connect(transport);

  const result = await client.callTool({
    name,
    arguments: params,
  });

  return result;
}
