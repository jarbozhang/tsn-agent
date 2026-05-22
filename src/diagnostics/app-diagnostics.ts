import type { ArtifactBundle } from "../export/artifact-bundle";
import { classifyArtifact } from "../export/artifact-classification";
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
    workflowStep: session.workflow.currentStep,
    workflowStatus: session.workflow.stages[session.workflow.currentStep]?.status,
    scenarioConfigId: session.workflow.scenarioConfigId,
    hasProject: Boolean(session.project),
    projectName: session.project?.name,
    artifactCount: session.bundle?.artifacts.length ?? 0,
    claudeSessionId: session.claudeSessionId,
  };
}

export function artifactBundleSummary(bundle: ArtifactBundle) {
  return {
    artifactCount: bundle.artifacts.length,
    files: bundle.artifacts.map((artifact) => {
      const classification = classifyArtifact(artifact);

      return {
        path: artifact.path,
        purpose: artifact.purpose,
        group: classification.group,
        isEntrypoint: classification.isEntrypoint,
        observedExternal: artifact.observedExternal === true,
        label: artifact.label ?? artifact.purpose,
        roleLabel: classification.roleLabel,
        contentLength: artifact.content.length,
      };
    }),
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
