import { createWorkflowStarter } from '@/mail';
import { createRouteBridge } from '@/platform/backend';
import { connectTemporalClient, startTemporalWorker } from '@/platform/temporal';
import { bindMailRoutes, bindMailWorkflows, mail } from './mail';

const bridge = createRouteBridge([mail.feature]);
bindMailRoutes(bridge.invoke);

export const worker = startTemporalWorker({
  workflowsPath: './workflows',
  activities: { ...mail.activities() },
});

export const client = connectTemporalClient().then((connected: any) => {
  bindMailWorkflows(createWorkflowStarter({ client: connected.client, taskQueue: connected.config.taskQueue }));
});
