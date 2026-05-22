import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  buildPrompt,
  extractOperationTraceEvents,
  extractStreamEventText,
  normalizeError,
  parseAssistantText,
  redactSecrets,
  runClaude,
} from "./claude-agent-worker.mjs";
import { runTopologyStage, writeStageResult } from "./stage-skills/tsn-stage-runner";

function failedTopologyStageResult(error) {
  const result = runTopologyStage({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" });
  return {
    ...result,
    status: "failed",
    validation: {
      ok: false,
      errors: [error],
    },
    safeEventSummary: {
      title: "拓扑结果",
      content: `拓扑校验失败：${error}`,
      status: "error",
    },
  };
}

async function* messages(items) {
  for (const item of items) {
    yield item;
  }
}

describe("claude-agent-worker", () => {
  it("maps structured output and session id from SDK messages", async () => {
    const query = async function* (input) {
      expect(input.options.settingSources).toEqual(["user", "project"]);
      expect(input.options.skills).toEqual(["tsn-topology", "tsn-flow-planning"]);
      expect(input.options.tools).toEqual({ type: "preset", preset: "claude_code" });
      expect(input.options.allowedTools).toEqual(expect.arrayContaining(["Skill", "Read", "Bash", "Edit", "Write"]));
      expect(input.options.disallowedTools).toEqual([]);
      expect(input.options.includePartialMessages).toBe(true);
      expect(input.options.systemPrompt).toContain("工程状态只接受结构化校验结果");
      expect(input.options.systemPrompt).toContain("拓扑、时间同步、流量规划、模拟仿真");
      expect(input.options.systemPrompt).toContain("不能声称已启动仿真");
      expect(input.prompt).toContain("TSN_AGENT_STAGE_RESULT_PATH");
      expect(input.prompt).toContain("TSN_AGENT_SKILL_OUTPUT_DIR");
      expect(input.prompt).toContain("--skill-output-dir");
      expect(input.options.env.TSN_AGENT_SKILL_OUTPUT_DIR).toContain("skill-output");
      yield* messages([
        { type: "system", session_id: "session-1" },
        { type: "result", structured_output: { assistantText: " 已生成拓扑说明 " } },
      ]);
    };

    const result = await runClaude(
      "我需要4个交换机",
      {
        cwd: "/tmp/project",
      },
      query,
    );

    expect(result.sessionId).toBe("session-1");
    expect(result.assistantText).toContain("已生成拓扑说明");
    expect(result.stageResults).toEqual([]);
  });

  it("reads and validates a topology stage result written to the run-scoped path", async () => {
    const events = [];
    const query = async function* (input) {
      const resultPath = input.options.env.TSN_AGENT_STAGE_RESULT_PATH;
      expect(resultPath).toContain("tsn-agent-stage-");
      await writeFile(
        resultPath,
        JSON.stringify(runTopologyStage({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" })),
        "utf8",
      );
      yield { type: "result", session_id: "session-stage", result: "拓扑已生成" };
    };

    const result = await runClaude("我需要4个交换机，每个交换机连接5个端系统", { onEvent: (event) => events.push(event) }, query);

    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "topology",
      skillName: "tsn-topology",
      validation: { ok: true, errors: [] },
    });
    expect(result.stageResults[0].payload.project.topology.nodes).toHaveLength(24);
    expect(events.map((event) => event.text ?? "").join("")).toContain(
      "[Skill] tsn-topology 结果已返回：4 个交换机，20 个端系统，23 条链路",
    );
  });

  it("runs a repair turn when the model does not write a structured topology result", async () => {
    const events = [];
    const auditDir = await mkdtemp(join(tmpdir(), "tsn-agent-repair-audit-test-"));
    let callCount = 0;
    const query = async function* (input) {
      callCount += 1;
      expect(input.prompt).toContain("stage-runner-input.json");
      expect(input.options.env.TSN_AGENT_STAGE_RUNNER_INPUT_PATH).toContain("stage-runner-input.json");
      if (callCount === 1) {
        yield { type: "system", session_id: "session-repair-runner" };
        yield { type: "result", session_id: "session-repair-runner", result: "拓扑已生成" };
        return;
      }

      expect(input.options.resume).toBe("session-repair-runner");
      expect(input.prompt).toContain("上一轮只返回了文字说明");
      await writeFile(
        input.options.env.TSN_AGENT_STAGE_RESULT_PATH,
        JSON.stringify(runTopologyStage({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" })),
        "utf8",
      );
      yield {
        type: "assistant",
        session_id: "session-repair-runner",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-repair",
              name: "Bash",
              input: {
                command:
                  'node "$TSN_AGENT_STAGE_RUNNER_PATH" --stage topology --input \'{"userIntent":"我需要4个交换机，每个交换机连接5个端系统"}\' --result-path "$TSN_AGENT_STAGE_RESULT_PATH"',
              },
            },
          ],
        },
      };
      yield { type: "result", session_id: "session-repair-runner", result: "拓扑结构化结果已生成" };
    };

    const result = await runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      {
        stageRunnerInput: {
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
        auditDir,
        appSessionId: "session-repair",
        runId: "agent-run-repair",
        onEvent: (event) => events.push(event),
      },
      query,
    );

    const streamed = events.map((event) => event.text ?? "").join("");
    const audit = JSON.parse(await readFile(result.auditPath, "utf8"));
    expect(callCount).toBe(2);
    expect(streamed).toContain("[工具] Bash: node tsn-stage-runner --stage topology");
    expect(result.assistantText).toContain("[工具] Bash: node tsn-stage-runner --stage topology");
    expect(result.assistantText).toContain("拓扑结构化结果已生成");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "topology",
      skillName: "tsn-topology",
      validation: { ok: true, errors: [] },
    });
    expect(audit.stageRunnerInputPath).toContain("stage-runner-input.json");
    expect(audit.promptRuns).toEqual([
      expect.objectContaining({
        id: "initial",
        kind: "initial",
        resultText: "拓扑已生成",
      }),
      expect.objectContaining({
        id: "2-missing_stage_result_retry",
        kind: "missing_stage_result_retry",
        prompt: expect.stringContaining("上一轮只返回了文字说明"),
        resultText: "拓扑结构化结果已生成",
      }),
    ]);
  });

  it("runs a repair turn when the structured topology result fails validation", async () => {
    let callCount = 0;
    const validationError = "通用分布式拓扑缺少交换机互联链路";
    const query = async function* (input) {
      callCount += 1;

      if (callCount === 1) {
        await writeFile(
          input.options.env.TSN_AGENT_STAGE_RESULT_PATH,
          JSON.stringify(failedTopologyStageResult(validationError)),
          "utf8",
        );
        yield { type: "system", session_id: "session-invalid-runner" };
        yield { type: "result", session_id: "session-invalid-runner", result: "拓扑已生成" };
        return;
      }

      expect(input.options.resume).toBe("session-invalid-runner");
      expect(input.prompt).toContain("上一轮已经写入 stage result，但校验未通过");
      expect(input.prompt).toContain(validationError);
      await writeFile(
        input.options.env.TSN_AGENT_STAGE_RESULT_PATH,
        JSON.stringify(runTopologyStage({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" })),
        "utf8",
      );
      yield { type: "result", session_id: "session-invalid-runner", result: "已补齐交换机互联链路" };
    };

    const result = await runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      {
        stageRunnerInput: {
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
      },
      query,
    );

    expect(callCount).toBe(2);
    expect(result.assistantText).toContain("已补齐交换机互联链路");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0].status).toBe("success");
  });

  it("surfaces SDK tool use and tool result events in the final assistant text", async () => {
    const events = [];
    const query = async function* () {
      yield { type: "system", session_id: "session-tool-trace" };
      yield {
        type: "assistant",
        session_id: "session-tool-trace",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "Bash",
              input: {
                command:
                  'node "$TSN_AGENT_STAGE_RUNNER_PATH" --stage flow-template --input \'{"userIntent":"加三条视频流"}\' --result-path "$TSN_AGENT_STAGE_RESULT_PATH"',
              },
            },
          ],
        },
      };
      yield {
        type: "user",
        session_id: "session-tool-trace",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-1",
              content: "ok",
            },
          ],
        },
      };
      yield { type: "result", session_id: "session-tool-trace", result: "已更新流量规划" };
    };

    const result = await runClaude("加三条视频流", { onEvent: (event) => events.push(event) }, query);

    const streamed = events.map((event) => event.text ?? "").join("");
    expect(streamed).toContain("[工具] Bash: node tsn-stage-runner --stage flow-template");
    expect(streamed).toContain("[工具结果] Bash 已返回");
    expect(result.assistantText).toContain("[工具] Bash: node tsn-stage-runner --stage flow-template");
    expect(result.assistantText).toContain("[工具结果] Bash 已返回");
    expect(result.assistantText).toContain("已更新流量规划");
  });

  it("writes a per-session audit log with prompt, result, and tool traces", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "tsn-agent-audit-test-"));
    const query = async function* (input) {
      await writeFile(
        input.options.env.TSN_AGENT_STAGE_RESULT_PATH,
        JSON.stringify(runTopologyStage({ userIntent: "我需要4个交换机" })),
        "utf8",
      );
      yield { type: "system", session_id: "sdk-session-audit" };
      yield {
        type: "assistant",
        session_id: "sdk-session-audit",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-audit",
              name: "Bash",
              input: {
                command:
                  'node "$TSN_AGENT_STAGE_RUNNER_PATH" --stage topology --input \'{"userIntent":"我需要4个交换机"}\' --result-path "$TSN_AGENT_STAGE_RESULT_PATH"',
              },
            },
          ],
        },
      };
      yield {
        type: "user",
        session_id: "sdk-session-audit",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-audit",
              content: "stage result written",
            },
          ],
        },
      };
      yield { type: "result", session_id: "sdk-session-audit", result: "拓扑已生成" };
    };

    const result = await runClaude(
      "我需要4个交换机",
      {
        auditDir,
        appSessionId: "session/audit:1",
        runId: "agent-run-audit",
        stageRunnerInput: {
          userIntent: "我需要4个交换机",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
      },
      query,
    );
    const auditRaw = await readFile(result.auditPath, "utf8");
    const audit = JSON.parse(auditRaw);
    const latestRaw = await readFile(join(auditDir, "session_audit_1", "latest.json"), "utf8");

    expect(result.auditPath).toContain("session_audit_1");
    expect(audit.schemaVersion).toBe("tsn-agent.agent-run-audit.v1");
    expect(audit.appSessionId).toBe("session/audit:1");
    expect(audit.runId).toBe("agent-run-audit");
    expect(audit.summary).toMatchObject({
      status: "success",
      stage: "topology",
      userPromptPreview: "我需要4个交换机",
      stageRunnerInputPath: expect.stringContaining("stage-runner-input.json"),
      promptRunCount: 1,
      recovered: false,
    });
    expect(audit.summary.prompt).toMatchObject({
      usesStageRunnerInputPath: true,
      hasInlineStageRunnerInputJson: false,
    });
    expect(audit.summary.context.includesLocalCandidate).toBe(false);
    expect(audit.prompt).toContain("用户原始需求：");
    expect(audit.prompt).toContain("我需要4个交换机");
    expect(audit.promptRuns).toEqual([
      expect.objectContaining({
        id: "initial",
        kind: "initial",
        promptSummary: expect.objectContaining({
          usesStageRunnerInputPath: true,
          hasInlineStageRunnerInputJson: false,
        }),
        prompt: expect.stringContaining("我需要4个交换机"),
        resultText: expect.stringContaining("拓扑已生成"),
      }),
    ]);
    expect(audit.sdkOptions.allowedTools).toEqual(["Skill", "Read", "Bash", "Edit", "Write"]);
    expect(audit.sdkOptions.skills).toEqual(["tsn-topology", "tsn-flow-planning"]);
    expect(audit.toolCalls.map((call) => call.text).join("\n")).toContain("[工具] Bash: node tsn-stage-runner --stage topology");
    expect(audit.toolCalls.map((call) => call.text).join("\n")).toContain("[工具结果] Bash 已返回");
    expect(audit.result.assistantText).toContain("拓扑已生成");
    expect(audit.sdkSessionId).toBe("sdk-session-audit");
    expect(JSON.parse(latestRaw).runId).toBe("agent-run-audit");
    expect(JSON.parse(latestRaw).summary.stageRunnerInputPath).toContain("stage-runner-input.json");
  });

  it("does not synthesize a topology stage result when the SDK stops at the turn limit", async () => {
    const query = async function* (input) {
      expect(input.options.maxTurns).toBe(3);
      yield { type: "system", session_id: "session-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };
    const stageRunner = vi.fn(async ({ input, resultPath }) => {
      await writeStageResult(runTopologyStage(input), resultPath);
    });

    await expect(runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      {
        maxTurns: 3,
        stageRunnerInput: {
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
        stageRunner,
      },
      query,
    )).rejects.toThrow("Reached maximum number of turns");
    expect(stageRunner).not.toHaveBeenCalled();
  });

  it("does not synthesize a flow planning stage result when the SDK stops at the turn limit", async () => {
    const query = async function* () {
      yield { type: "system", session_id: "session-flow-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };

    const project = runTopologyStage({
      userIntent: "我需要3个交换机，每个交换机连接3个端系统，使用环形互联",
    }).payload.project;
    const stageRunner = vi.fn(async ({ input, resultPath }) => {
      const { runFlowPlanningStage } = await import("./stage-skills/tsn-stage-runner");
      await writeStageResult(runFlowPlanningStage(input), resultPath);
    });

    await expect(runClaude(
      "再加3条视频流吧",
      {
        stageRunnerInput: {
          userIntent: "再加3条视频流吧",
          stage: "flow-template",
          scenarioConfigId: "generic-tsn",
          project,
        },
        stageRunner,
      },
      query,
    )).rejects.toThrow("Reached maximum number of turns");
    expect(stageRunner).not.toHaveBeenCalled();
  });

  it("ignores malformed stage result files", async () => {
    const query = async function* (input) {
      await writeFile(input.options.env.TSN_AGENT_STAGE_RESULT_PATH, "{bad json", "utf8");
      yield { type: "result", result: "只返回文本" };
    };

    const result = await runClaude("需求", undefined, query);

    expect(result.assistantText).toBe("只返回文本");
    expect(result.stageResults).toEqual([]);
  });

  it("passes resume session and conversation context to Claude", async () => {
    const query = async function* (input) {
      expect(input.options.resume).toBe("session-old");
      expect(input.prompt).toContain("上一轮已生成拓扑");
      yield { type: "result", session_id: "session-old", result: "继续配置时钟同步" };
    };

    await expect(
      runClaude("继续", { resumeSessionId: "session-old", conversationContext: "上一轮已生成拓扑" }, query),
    ).resolves.toMatchObject({
      assistantText: "继续配置时钟同步",
      sessionId: "session-old",
      stageResults: [],
    });
  });

  it("emits streaming chunks from partial messages", async () => {
    const events = [];
    const query = async function* () {
      yield { type: "system", session_id: "session-stream" };
      yield {
        type: "stream_event",
        session_id: "session-stream",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一段" } },
      };
      yield {
        type: "stream_event",
        session_id: "session-stream",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "第二段" } },
      };
      yield { type: "result", session_id: "session-stream", result: "" };
    };

    const result = await runClaude("需求", { onEvent: (event) => events.push(event) }, query);

    expect(result.assistantText).toBe("第一段第二段");
    expect(result.stageResults).toEqual([]);
    expect(events).toEqual([
      { event: "session", sessionId: "session-stream" },
      { event: "chunk", text: "第一段" },
      { event: "chunk", text: "第二段" },
    ]);
  });

  it("falls back to JSON string result text", async () => {
    const query = async function* () {
      yield { type: "result", session_id: "session-2", result: '{"assistantText":"JSON 字符串回复"}' };
    };

    await expect(runClaude("需求", undefined, query)).resolves.toEqual({
      assistantText: "JSON 字符串回复",
      sessionId: "session-2",
      stageResults: [],
    });
  });

  it("falls back to plain result text", async () => {
    const query = async function* () {
      yield { type: "result", result: "普通回复" };
    };

    await expect(runClaude("需求", undefined, query)).resolves.toMatchObject({
      assistantText: "普通回复",
    });
  });

  it("rejects empty assistant output", async () => {
    const query = async function* () {
      yield { type: "result", structured_output: { assistantText: "   " } };
    };

    await expect(runClaude("需求", undefined, query)).rejects.toThrow("no assistantText");
  });

  it("builds a TSN-specific prompt", () => {
    const prompt = buildPrompt(
      "我需要4个交换机",
      "历史上下文",
      "/tmp/result.json",
      "/tmp/skill-output",
      { userIntent: "我需要4个交换机", scenarioConfigId: "generic-tsn" },
    );

    expect(prompt).toContain("我需要4个交换机");
    expect(prompt).toContain("历史上下文");
    expect(prompt).toContain("stage runner 结构化输入");
    expect(prompt).toContain('"scenarioConfigId": "generic-tsn"');
    expect(prompt).toContain("只描述当前阶段已经完成或正在等待确认的内容");
    expect(prompt).toContain("拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真");
    expect(prompt).toContain("当前应用没有接入 OMNeT++/远程服务器仿真 runner");
    expect(prompt).toContain("/tmp/result.json");
    expect(prompt).toContain("/tmp/skill-output");
    expect(prompt).toContain("--skill-output-dir");
    expect(prompt).not.toContain("然后继续生成控制流模板和导出文件");
  });

  it("keeps large stage runner input out of the prompt when an input path is provided", () => {
    const prompt = buildPrompt(
      "再加个视频流",
      "历史上下文",
      "/tmp/result.json",
      "/tmp/skill-output",
      {
        userIntent: "再加个视频流",
        stage: "flow-template",
        project: {
          topology: {
            nodes: Array.from({ length: 20 }, (_, index) => ({ id: `node-${index}` })),
          },
        },
      },
      "/tmp/runner.mjs",
      "/tmp/stage-runner-input.json",
    );

    expect(prompt).toContain("/tmp/stage-runner-input.json");
    expect(prompt).not.toContain("node-19");
  });

  it("redacts common secret shapes", () => {
    const redacted = redactSecrets(
      'api_key=sk-ant-secret token: abc123 "refreshToken":"oauth-secret" Authorization: Bearer bearer-secret',
    );

    expect(redacted).not.toContain("sk-ant-secret");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("oauth-secret");
    expect(redacted).not.toContain("bearer-secret");
    expect(redacted).toContain("[redacted]");
  });

  it("normalizes thrown errors with redaction", () => {
    expect(normalizeError(new Error("CLAUDE_API_KEY=secret"))).not.toContain("secret");
  });

  it("parses assistantText from JSON result strings", () => {
    expect(parseAssistantText('{"assistantText":"ok"}')).toBe("ok");
    expect(parseAssistantText("plain")).toBe("plain");
  });

  it("extracts text deltas from stream events", () => {
    expect(
      extractStreamEventText({
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "delta" } },
      }),
    ).toEqual(["delta"]);
    expect(extractStreamEventText({ event: { type: "message_stop" } })).toEqual([]);
  });

  it("extracts file operation traces from SDK tool blocks", () => {
    const traces = extractOperationTraceEvents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/app/App.tsx" } },
          { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/tmp/stage-result.json" } },
          { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/agent/fake-agent.ts" } },
        ],
      },
    });

    expect(traces.map((trace) => trace.text)).toEqual([
      "[文件] 读取 src/app/App.tsx",
      "[文件] 写入 stage-result.json",
      "[文件] 修改 src/agent/fake-agent.ts",
    ]);
  });

  it("keeps later detailed tool-use events when an earlier stream event had empty input", () => {
    const toolUseNamesById = new Map();
    const emptyTrace = extractOperationTraceEvents({
      type: "stream_event",
      event: {
        content_block: {
          type: "tool_use",
          id: "read-1",
          name: "Read",
          input: {},
        },
      },
    }, toolUseNamesById);
    const detailedTrace = extractOperationTraceEvents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/skill-output/topology.json" } },
        ],
      },
    }, toolUseNamesById);

    expect(emptyTrace.map((trace) => trace.text)).toEqual([]);
    expect(detailedTrace.map((trace) => trace.text)).toEqual(["[文件] 读取 topology.json"]);
  });

  it("summarizes successful and failed tool results", () => {
    const toolUseNamesById = new Map([["bash-1", "Bash"], ["write-1", "Write"]]);
    const traces = extractOperationTraceEvents({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: "Intermediate JSON written.",
          },
          {
            type: "tool_result",
            tool_use_id: "write-1",
            content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
          },
        ],
      },
    }, toolUseNamesById);

    expect(traces.map((trace) => trace.text)).toEqual([
      "[工具结果] Bash 已返回：Intermediate JSON written.",
      "[工具结果] Write 已返回（失败）：File has not been read yet. Read it first before writing to it.",
    ]);
  });

  it("does not expose empty tool input objects in operation traces", () => {
    const traces = extractOperationTraceEvents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "skill-1", name: "Skill", input: {} },
          { type: "tool_use", id: "bash-1", name: "Bash", input: {} },
        ],
      },
    });

    expect(traces.map((trace) => trace.text)).toEqual([]);
    expect(traces.map((trace) => trace.text).join("\n")).not.toContain("{}");
  });
});
