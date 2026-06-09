import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SkillFileService } from "../../skills/skill-file-service";
import { SkillFilePreview } from "./SkillFilePreview";

function createService(overrides: Partial<SkillFileService> = {}): SkillFileService {
  return {
    listFiles: vi.fn().mockResolvedValue({
      skillId: "tsn-topology",
      status: "available",
      files: [
        {
          path: "SKILL.md",
          kind: "file",
          sizeBytes: 24,
          canPreview: true,
          canEdit: true,
        },
        {
          path: "tools/binary.bin",
          kind: "file",
          sizeBytes: 4,
          canPreview: false,
          canEdit: false,
          reason: "非 UTF-8 文本文件不可预览。",
        },
      ],
    }),
    readFile: vi.fn().mockResolvedValue({
      skillId: "tsn-topology",
      path: "SKILL.md",
      content: "原始 skill 内容",
      editable: true,
    }),
    writeFile: vi.fn().mockImplementation(async (_skillId, path, content) => ({
      skillId: "tsn-topology",
      path,
      content,
      editable: true,
    })),
    describeTopologyTemplates: vi.fn().mockResolvedValue({
      templateCount: 3,
      templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"],
      templates: [],
    }),
    ...overrides,
  };
}

describe("SkillFilePreview", () => {
  it("lists skill files and previews SKILL.md by default", async () => {
    const service = createService();

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByRole("button", { name: /SKILL.md/ })).toBeInTheDocument();
    expect(await screen.findByText("原始 skill 内容")).toBeInTheDocument();
    expect(service.listFiles).toHaveBeenCalledWith("tsn-topology");
    expect(service.readFile).toHaveBeenCalledWith("tsn-topology", "SKILL.md");
  });

  it("edits and saves small text files", async () => {
    const user = userEvent.setup();
    const service = createService();

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: "编辑文件" }));
    await user.clear(screen.getByLabelText("Skill 文件内容"));
    await user.type(screen.getByLabelText("Skill 文件内容"), "更新后的内容");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(service.writeFile).toHaveBeenCalledWith("tsn-topology", "SKILL.md", "更新后的内容");
    });
    expect(await screen.findByText("更新后的内容")).toBeInTheDocument();
  });

  it("keeps draft content when save fails", async () => {
    const user = userEvent.setup();
    const service = createService({
      writeFile: vi.fn().mockRejectedValue(new Error("保存失败")),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: "编辑文件" }));
    await user.clear(screen.getByLabelText("Skill 文件内容"));
    await user.type(screen.getByLabelText("Skill 文件内容"), "未保存内容");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(screen.getByDisplayValue("未保存内容")).toBeInTheDocument();
  });

  it("shows unavailable state when a skill has no file directory", async () => {
    const service = createService({
      listFiles: vi.fn().mockResolvedValue({
        skillId: "tsn-time-sync",
        status: "unavailable",
        files: [],
        message: "暂无可预览的 skill 文件目录。",
      }),
    });

    render(<SkillFilePreview skillId="tsn-time-sync" service={service} />);

    expect(await screen.findByText("暂无可预览的 skill 文件目录。")).toBeInTheDocument();
    expect(screen.getByText("暂无目录")).toBeInTheDocument();
  });

  it("does not edit readonly files", async () => {
    const service = createService({
      readFile: vi.fn().mockResolvedValue({
        skillId: "tsn-topology",
        path: "SKILL.md",
        content: "只读内容",
        editable: false,
        readonlyReason: "只读 skill 资源不可编辑。",
      }),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByText("只读内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑文件" })).toBeDisabled();
    expect(screen.getByText("只读 skill 资源不可编辑。")).toBeInTheDocument();
  });
});
