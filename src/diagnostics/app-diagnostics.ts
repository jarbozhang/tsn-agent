import type { ArtifactBundle } from "../export/artifact-bundle";
import type { TsnSession } from "../sessions/session-repository";
import type { DiagnosticLogRepository } from "./diagnostic-log-repository";
import { summarizeText, type DiagnosticLogInput } from "./diagnostic-log";

export function logDiagnostic(repository: DiagnosticLogRepository, input: DiagnosticLogInput): void {
  void repository.append(input);
}

export function sessionSummary(session: TsnSession) {
  return {
    title: session.title,
    messageCount: session.messages.length,
    eventCount: session.agentEvents.length,
    hasProject: Boolean(session.project),
    projectName: session.project?.name,
    artifactCount: session.bundle?.artifacts.length ?? 0,
    claudeSessionId: session.claudeSessionId,
  };
}

export function artifactBundleSummary(bundle: ArtifactBundle) {
  return {
    artifactCount: bundle.artifacts.length,
    files: bundle.artifacts.map((artifact) => ({
      path: artifact.path,
      purpose: artifact.purpose,
      label: artifact.label ?? artifact.purpose,
      contentLength: artifact.content.length,
    })),
    projectId: bundle.manifest.projectId,
    generatedAt: bundle.manifest.generatedAt,
  };
}

export function userIntentPreview(value: string) {
  return {
    preview: summarizeText(value),
    charCount: value.length,
  };
}
