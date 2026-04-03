export type { WorkloadFn, WorkloadContext } from '../types.js';

export interface CursorState {
  lastTs: Date | string;
  lastId: string;
}
