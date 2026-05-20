import { query } from "@anthropic-ai/claude-agent-sdk";

export const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assistantText: {
      type: "string",
      description: "中文回复，直接展示给 TSN Agent 左侧对话框。",
    },
  },
  required: ["assistantText"],
};

export async function runClaude(userPrompt, options = {}, queryFn = query) {
  const resolvedOptions = typeof options === "string" ? { cwd: options } : options;
  let assistantText = "";
  let sessionId;
  let emittedSessionId;
  const emittedText = [];

  for await (const message of queryFn({
    prompt: buildPrompt(userPrompt, resolvedOptions.conversationContext),
    options: {
      cwd: typeof resolvedOptions.cwd === "string" && resolvedOptions.cwd.length > 0 ? resolvedOptions.cwd : process.cwd(),
      settingSources: ["user"],
      permissionMode: "dontAsk",
      tools: [],
      allowedTools: [],
      disallowedTools: ["Bash", "Edit", "Write"],
      maxTurns: 3,
      includePartialMessages: true,
      ...(typeof resolvedOptions.resumeSessionId === "string" && resolvedOptions.resumeSessionId.length > 0
        ? { resume: resolvedOptions.resumeSessionId }
        : {}),
      systemPrompt:
        "你是 TSN Agent 的规划助手。你面向懂一点 TSN 但不了解具体参数的新手用户。回复必须是简体中文，保持工程化、具体、可执行。不要读取文件、不要调用工具、不要使用本机项目配置。",
    },
  })) {
    if (message.type === "system" && message.session_id) {
      sessionId = message.session_id;
      if (sessionId !== emittedSessionId) {
        emittedSessionId = sessionId;
        resolvedOptions.onEvent?.({ event: "session", sessionId });
      }
    }

    if (message.type === "assistant") {
      sessionId = message.session_id ?? sessionId;

      if (emittedText.length === 0) {
        for (const text of extractAssistantTextBlocks(message)) {
          emittedText.push(text);
          resolvedOptions.onEvent?.({ event: "chunk", text });
        }
      }
    }

    if (message.type === "stream_event") {
      sessionId = message.session_id ?? sessionId;

      for (const text of extractStreamEventText(message)) {
        emittedText.push(text);
        resolvedOptions.onEvent?.({ event: "chunk", text });
      }
    }

    if (message.type === "result") {
      sessionId = message.session_id ?? sessionId;

      if (message.structured_output?.assistantText) {
        assistantText = message.structured_output.assistantText;
      } else if (typeof message.result === "string") {
        assistantText = parseAssistantText(message.result);
      }
    }
  }

  if (!assistantText.trim() && emittedText.length > 0) {
    assistantText = emittedText.join("");
  }

  if (!assistantText.trim()) {
    throw new Error("Claude returned no assistantText");
  }

  return {
    assistantText: assistantText.trim(),
    sessionId,
  };
}

export function buildPrompt(userPrompt, conversationContext) {
  const contextBlock = conversationContext
    ? `\n会话上下文：\n${conversationContext}\n`
    : "";

  return `用户正在通过 TSN Agent 桌面应用配置一个 TSN 网络。
${contextBlock}

用户原始需求：
${userPrompt}

请直接生成左侧对话框要展示给用户的中文内容，不要输出 JSON。要求：
1. 用新手能理解的语言解释你识别到了哪些拓扑规模和默认假设。
2. 明确说明当前会进入 tsn-topology skill 生成拓扑，然后继续生成控制流模板和导出文件。
3. 不要修改文件，不要执行 shell 命令，不要输出 Markdown 表格。
4. 如果需求缺少关键参数，请给出合理默认值并说明这些默认值后续可以调整。`;
}

export function extractAssistantTextBlocks(message) {
  const content = message.message?.content;

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0)
    .map((block) => block.text);
}

export function extractStreamEventText(message) {
  const event = message.event;

  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return [event.delta.text].filter(Boolean);
  }

  if (event?.type === "content_block_start" && event.content_block?.type === "text") {
    return [event.content_block.text].filter(Boolean);
  }

  return [];
}

export function parseAssistantText(value) {
  try {
    const parsed = JSON.parse(value);

    if (typeof parsed.assistantText === "string") {
      return parsed.assistantText;
    }
  } catch {
    return value;
  }

  return value;
}

export function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message);
}

export function redactSecrets(value) {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|claude_api_key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/("(?:accessToken|refreshToken|authToken|apiKey|api_key|token|secret|password)"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s,;]+)/gi, "$1[redacted]");
}

export async function runWorker(rawInput) {
  const input = JSON.parse(rawInput);
  const prompt = String(input.prompt ?? "").trim();

  if (!prompt) {
    throw new Error("prompt is required");
  }

  return runClaude(prompt, {
    cwd: input.cwd,
    conversationContext: typeof input.conversationContext === "string" ? input.conversationContext : undefined,
    resumeSessionId: typeof input.resumeSessionId === "string" ? input.resumeSessionId : undefined,
    onEvent: (event) => {
      if (typeof input.runId !== "string" || !input.runId) {
        return;
      }

      process.stdout.write(`${JSON.stringify({ ...event, runId: input.runId })}\n`);
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , rawInput = "{}"] = process.argv;

  try {
    const response = await runWorker(rawInput);
    process.stdout.write(`${JSON.stringify({ event: "done", ...response })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: normalizeError(error) })}\n`);
    process.exitCode = 1;
  }
}
