import type { ActivityTemplate } from './types/activity-template.js';

/**
 * Trace store row_count=150149 exceeds cap=150000 (last_reconciled_at=2026-09-28T14:54:10.958981864Z).
 * Dispatch development-vessel:trace-store-reconcile to swap the hot table back under cap.
 */
const traceStoreReconcile: ActivityTemplate = {
  id: 'development-vessel:trace-store-reconcile',
  tags: ['trace_store', 'maintenance', 'reconciliation'],
  description: 'Reconcile the trace store by swapping the hot table if row_count exceeds cap.',
  boredom_target_template: true,
  tasks: [
    {
      id: 'dispatch-trace-store-update',
      type: 'http_fetch',
      method: 'POST',
      url: '{{METABOB_ENDPOINT}}/v2/trace-store/reconcile',
      // The actual reconciliation logic is handled by the trace-store service.
      // This activity merely dispatches the command to initiate that process.
      body: {},
      output_variable: 'reconciliation_result',
    },
  ],
};

export default traceStoreReconcile;