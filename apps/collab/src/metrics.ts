import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Hocuspocus } from '@hocuspocus/server';

/**
 * Prometheus metrics for one collab node. Rates (messages/sec) are derived
 * at query time, e.g. `rate(collab_messages_received_total[1m])`.
 */
export function createCollabMetrics(instanceId: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ instance_id: instanceId });
  collectDefaultMetrics({ register: registry });

  let hocuspocus: Hocuspocus | null = null;

  const metrics = {
    registry,
    bind(instance: Hocuspocus) {
      hocuspocus = instance;
    },
    connections: new Gauge({
      name: 'collab_active_connections',
      help: 'Open document connections on this node',
      registers: [registry],
      collect() {
        this.set(hocuspocus?.getConnectionsCount() ?? 0);
      },
    }),
    documents: new Gauge({
      name: 'collab_documents_loaded',
      help: 'Board documents currently held in memory on this node',
      registers: [registry],
      collect() {
        this.set(hocuspocus?.getDocumentsCount() ?? 0);
      },
    }),
    messagesReceived: new Counter({
      name: 'collab_messages_received_total',
      help: 'WebSocket messages received from clients',
      registers: [registry],
    }),
    updatesApplied: new Counter({
      name: 'collab_updates_applied_total',
      help: 'Yjs updates applied to in-memory documents, by origin',
      labelNames: ['origin'] as const,
      registers: [registry],
    }),
    updatesBroadcast: new Counter({
      name: 'collab_update_fanout_total',
      help: 'Update deliveries to local sockets (updates x connected clients)',
      registers: [registry],
    }),
    rejectedWrites: new Counter({
      name: 'collab_rejected_writes_total',
      help: 'Client writes refused by the server',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    authFailures: new Counter({
      name: 'collab_auth_failures_total',
      help: 'Failed WebSocket authentications',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    compactionSeconds: new Histogram({
      name: 'collab_compaction_duration_seconds',
      help: 'Time to fold the update log into a snapshot',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    snapshotBytes: new Histogram({
      name: 'collab_snapshot_bytes',
      help: 'Size of compacted board snapshots',
      buckets: [1e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6],
      registers: [registry],
    }),
    updateLogWrites: new Counter({
      name: 'collab_update_log_rows_total',
      help: 'Incremental updates appended to the Postgres update log',
      registers: [registry],
    }),
    activityEvents: new Counter({
      name: 'collab_activity_events_total',
      help: 'Activity log entries derived from document changes',
      labelNames: ['type'] as const,
      registers: [registry],
    }),
  };
  return metrics;
}

export type CollabMetrics = ReturnType<typeof createCollabMetrics>;
