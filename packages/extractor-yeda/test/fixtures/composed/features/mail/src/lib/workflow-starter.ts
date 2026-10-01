import type { Client } from '@temporalio/client';
import type { StartLetterWorkflow } from './relay';

/** The engine is handed in by the service; this only knows how to address a workflow. */
export function createWorkflowStarter(options: { readonly client: Client; readonly taskQueue: string }): StartLetterWorkflow {
  return async ({ letterId }) => {
    await options.client.workflow.start('letterWorkflow', {
      taskQueue: options.taskQueue,
      workflowId: `letter:${letterId}`,
      args: [{ letterId }],
    });
  };
}
