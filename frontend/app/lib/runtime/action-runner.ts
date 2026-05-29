import { map, type MapStore } from 'nanostores';
import * as nodePath from 'node:path';
import type { BoltAction } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';
import type { RuntimeConnection, ShellExecResponse } from '~/lib/runtime/types';

const logger = createScopedLogger('ActionRunner');

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed'>>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

export class ActionRunner {
  #connection: Promise<RuntimeConnection>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();

  actions: ActionsMap = map({});

  constructor(connectionPromise: Promise<RuntimeConnection>) {
    this.#connection = connectionPromise;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      // action already added
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.#updateAction(actionId, { status: 'running' });
    });
  }

  async runAction(data: ActionCallbackData) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return;
    }

    this.#updateAction(actionId, { ...action, ...data.action, executed: true });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId);
      })
      .catch((error) => {
        console.error('Action failed:', error);
      });
  }

  async #executeAction(actionId: string) {
    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          await this.#runShellAction(action);
          break;
        }
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
      }

      this.#updateAction(actionId, { status: action.abortSignal.aborted ? 'aborted' : 'complete' });
    } catch (error) {
      this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runShellAction(action: ActionState) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }

    const conn = await this.#connection;

    // Dev server commands (npm run dev, npx vite, etc.) run indefinitely.
    // Race the shell response against a port:open event so we don't block
    // the action queue waiting for a process that never exits.
    const isDevServer = /\b(npm run dev|npx vite|vite)\b/.test(action.content);

    if (isDevServer) {
      const portPromise = new Promise<void>((resolve) => {
        const handler = () => {
          conn.off('port:open:event', handler);
          resolve();
        };
        conn.on('port:open:event', handler);
      });

      // Fire the shell command (don't await — it never resolves for dev servers)
      conn.request<ShellExecResponse>({
        type: 'shell:exec:req',
        payload: {
          command: action.content,
          env: { npm_config_yes: 'true' },
          streamOutput: true,
        },
      }).catch(() => {
        // Timeout expected for long-running dev servers
      });

      // Wait for either a port to open or a reasonable timeout
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 120000));
      await Promise.race([portPromise, timeout]);
      logger.debug('Dev server action completed (port opened or timeout)');
      return;
    }

    const response = await conn.request<ShellExecResponse>({
      type: 'shell:exec:req',
      payload: {
        command: action.content,
        env: { npm_config_yes: 'true' },
        streamOutput: true,
      },
    });

    const exitCode = response.payload.exitCode;

    logger.debug(`Process terminated with code ${exitCode}`);

    if (exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${action.content}`);
    }
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    const conn = await this.#connection;

    // Ensure parent directory exists
    let folder = nodePath.dirname(action.filePath);
    folder = folder.replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await conn.request({
          type: 'fs:mkdir:req',
          payload: { path: folder },
        });
        logger.debug('Created folder', folder);
      } catch (error) {
        logger.error('Failed to create folder\n\n', error);
      }
    }

    try {
      await conn.request({
        type: 'fs:write:req',
        payload: {
          path: action.filePath,
          content: action.content,
          encoding: 'utf8',
        },
      });
      logger.debug(`File written ${action.filePath}`);
    } catch (error) {
      logger.error('Failed to write file\n\n', error);
    }
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }
}
