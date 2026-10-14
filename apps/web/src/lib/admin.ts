import type { AdminCoin, AdminLaunch, AdminLogEntry, AdminOverview, AdminReport, HideCoinRequest } from "@holdfast/core";
import { request } from "./api";

/** Operator endpoints (`/admin/*`, docs/api.md); every call carries the ADMIN_TOKEN as a bearer token. */
export function adminClient(token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const get = <T,>(path: string) => request<T>(path, { headers: auth });
  const post = <T,>(path: string, json: unknown = {}) => request<T>(path, { method: "POST", json, headers: auth });
  const enc = encodeURIComponent;
  return {
    overview: () => get<AdminOverview>("/admin/overview"),
    coins: () => get<AdminCoin[]>("/admin/coins"),
    reports: (all = false) => get<AdminReport[]>(`/admin/reports?all=${all ? 1 : 0}`),
    launches: (statuses: string[]) => get<AdminLaunch[]>(`/admin/launches${statuses.length ? `?status=${statuses.join(",")}` : ""}`),
    log: () => get<AdminLogEntry[]>("/admin/log"),
    hide: (mint: string, body: HideCoinRequest) => post(`/admin/coins/${enc(mint)}/hide`, body),
    unhide: (mint: string) => post(`/admin/coins/${enc(mint)}/unhide`),
    reviewed: (mint: string) => post(`/admin/coins/${enc(mint)}/reviewed`),
    resolveReport: (id: number, resolution: string) => post(`/admin/reports/${id}/resolve`, { resolution }),
    retryLaunch: (id: string) => post<AdminLaunch>(`/admin/launches/${enc(id)}/retry`),
  };
}

export type AdminClient = ReturnType<typeof adminClient>;
