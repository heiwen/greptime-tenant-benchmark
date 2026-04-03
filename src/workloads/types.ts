export type { WorkloadFn, WorkloadContext } from '../types.js';

export interface CursorState {
  lastTs: bigint;
  lastId: string;
}
