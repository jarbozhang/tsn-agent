import { invoke } from "@tauri-apps/api/core";
import {
  resolvePlannerBaseUrl,
  type PlannerPlanIdRequest,
  type PlannerQueryStatusResponseData,
  type PlannerResultResponseData,
  type PlannerServiceEnvelope,
  type PlannerStartRequest,
  type PlannerStartResponseData,
  type PlannerStopResponseData,
} from "./planner-contract";

export interface PlannerClientInput<TPayload> {
  baseUrl?: string;
  request: TPayload;
}

export interface PlannerPlanIdInput {
  baseUrl?: string;
  planId: string;
}

export interface PlannerStopInput {
  baseUrl?: string;
  planId?: string;
}

interface PlannerCommandRequest<TPayload> {
  baseUrl: string;
  payload: TPayload;
}

export async function startPlannerPlan(
  input: PlannerClientInput<PlannerStartRequest>,
): Promise<PlannerServiceEnvelope<PlannerStartResponseData>> {
  return invokePlannerCommand("planner_start_plan", input.baseUrl, input.request);
}

export async function queryPlannerPlanStatus(
  input: PlannerPlanIdInput,
): Promise<PlannerServiceEnvelope<PlannerQueryStatusResponseData>> {
  return invokePlannerCommand("planner_query_plan_status", input.baseUrl, createPlanIdRequest(input.planId));
}

export async function getPlannerPlanResult(
  input: PlannerPlanIdInput,
): Promise<PlannerServiceEnvelope<PlannerResultResponseData>> {
  return invokePlannerCommand("planner_get_plan_result", input.baseUrl, createPlanIdRequest(input.planId));
}

export async function stopPlannerPlan(
  input: PlannerStopInput,
): Promise<PlannerServiceEnvelope<PlannerStopResponseData>> {
  return invokePlannerCommand("planner_stop_plan", input.baseUrl, {
    sendData: {
      plan_id: input.planId?.trim() || null,
    },
  });
}

function createPlanIdRequest(planId: string): PlannerPlanIdRequest {
  const trimmedPlanId = planId.trim();

  if (!trimmedPlanId) {
    throw new Error("规划任务 ID 不能为空。");
  }

  return {
    sendData: {
      plan_id: trimmedPlanId,
    },
  };
}

async function invokePlannerCommand<TPayload, TData>(
  command: string,
  baseUrl: string | undefined,
  payload: TPayload,
): Promise<PlannerServiceEnvelope<TData>> {
  if (!isTauriRuntime()) {
    throw new Error("规划服务调用需要桌面运行时。");
  }

  return invoke<PlannerServiceEnvelope<TData>>(command, {
    request: {
      baseUrl: resolvePlannerBaseUrl(baseUrl),
      payload,
    } satisfies PlannerCommandRequest<TPayload>,
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
