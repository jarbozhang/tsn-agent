---
title: "tsn-topology 嵌套仓库状态"
type: note
date: 2026-05-20
---

# tsn-topology 嵌套仓库状态

`tsn-topology/` 是现有的独立 Git 仓库，并且当前存在未提交修改与未跟踪文件。根目录应用初始化后将其作为只读迁移参考，不纳入根仓库版本管理。

在明确它后续是 submodule、vendor copy、迁移源，还是独立 skill 发布仓库之前，不在根目录任务中修改、移动或清理其中任何文件。
