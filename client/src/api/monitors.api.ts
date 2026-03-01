import apiClient from './client';
import type { Monitor, Heartbeat, ApiResponse, BulkEditRequest } from '@obliview/shared';

export const monitorsApi = {
  async list(): Promise<Monitor[]> {
    const res = await apiClient.get<ApiResponse<Monitor[]>>('/monitors');
    return res.data.data!;
  },

  async getById(id: number): Promise<Monitor> {
    const res = await apiClient.get<ApiResponse<Monitor>>(`/monitors/${id}`);
    return res.data.data!;
  },

  async create(data: Partial<Monitor>): Promise<Monitor> {
    const res = await apiClient.post<ApiResponse<Monitor>>('/monitors', data);
    return res.data.data!;
  },

  async update(id: number, data: Partial<Monitor>): Promise<Monitor> {
    const res = await apiClient.put<ApiResponse<Monitor>>(`/monitors/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/monitors/${id}`);
  },

  async pause(id: number): Promise<{ id: number; status: string }> {
    const res = await apiClient.post<ApiResponse<{ id: number; status: string }>>(`/monitors/${id}/pause`);
    return res.data.data!;
  },

  async bulkUpdate(data: BulkEditRequest): Promise<Monitor[]> {
    const res = await apiClient.patch<ApiResponse<Monitor[]>>('/monitors/bulk', data);
    return res.data.data!;
  },

  async getHeartbeats(monitorId: number, limit = 100, offset = 0): Promise<Heartbeat[]> {
    const res = await apiClient.get<ApiResponse<Heartbeat[]>>(
      `/monitors/${monitorId}/heartbeats`,
      { params: { limit, offset } },
    );
    return res.data.data!;
  },

  async getHeartbeatsByPeriod(
    monitorId: number,
    period: '1h' | '24h' | '7d' | '30d' | '365d',
  ): Promise<Heartbeat[]> {
    const res = await apiClient.get<ApiResponse<Heartbeat[]>>(
      `/monitors/${monitorId}/heartbeats`,
      { params: { period } },
    );
    return res.data.data!;
  },

  async getHeartbeatsByRange(
    monitorId: number,
    from: Date,
    to: Date,
  ): Promise<Heartbeat[]> {
    const res = await apiClient.get<ApiResponse<Heartbeat[]>>(
      `/monitors/${monitorId}/heartbeats`,
      { params: { from: from.toISOString(), to: to.toISOString() } },
    );
    return res.data.data!;
  },

  async getStats(
    monitorId: number,
    period: '1h' | '24h' | '7d' | '30d' | '365d' = '24h',
  ): Promise<{
    total: number;
    up: number;
    down: number;
    uptimePct: number;
    avgResponseTime: number | null;
    minResponseTime: number | null;
    maxResponseTime: number | null;
    period: string;
  }> {
    const res = await apiClient.get(`/monitors/${monitorId}/stats`, { params: { period } });
    return res.data.data;
  },

  async getSummary(): Promise<Record<number, { uptimePct: number; avgResponseTime: number | null }>> {
    const res = await apiClient.get('/monitors/summary');
    return res.data.data;
  },

  async getAllHeartbeats(count = 50): Promise<Record<number, Heartbeat[]>> {
    const res = await apiClient.get<ApiResponse<Record<number, Heartbeat[]>>>(
      '/monitors/heartbeats/all',
      { params: { count } },
    );
    return res.data.data!;
  },
};
