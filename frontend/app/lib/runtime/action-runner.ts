import { map, type MapStore } from 'nanostores';
import * as nodePath from 'node:path';
import type { VibeAction } from '~/types/actions';
import { toast } from 'react-toastify';
import { createScopedLogger } from '~/utils/logger';
import {
  DEV_SERVER_PORT_TIMEOUT_MS,
  SHELL_REQUEST_TIMEOUT_MS,
  isDevServerCommand,
} from './shell-actions';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';
import type { RuntimeConnection, ShellExecResponse } from '~/lib/runtime/types';

const logger = createScopedLogger('ActionRunner');

/** Collapse a burst of failures into one message. */
const FAILURE_REPORT_INTERVAL_MS = 10_000;

/**
 * How many times to retry an operation that failed for a connection reason.
 *
 * The sandbox socket can be mid-reconnect when the first action of an artifact
 * runs — creating the session needs an authenticated identity and auth may not
 * have hydrated yet. `RuntimeConnectionImpl` recovers on its own within seconds,
 * so the first attempt losing that race is transient, not terminal. Matches the
 * bounded retry the file store already does around its own connect.
 */
const RETRY_ATTEMPTS = 3;

/** Backoff between retries, capped so a whole artifact never stalls for long. */
function retryDelayMs(attempt: number): number {
  return Math.min(400 * 2 ** (attempt - 1), 3000);
}

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = VibeAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

export type FailedActionState = VibeAction &
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
  /**
   * Resolve a healthy connection on demand rather than holding one promise.
   *
   * Capturing a single boot promise is what made actions fail permanently after
   * a lost boot race: the promise rejected once and every action afterwards
   * awaited that same dead promise. Calling a provider per operation lets a
   * failed or dropped connection be re-booted transparently.
   */
  #connect: () => Promise<RuntimeConnection>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  #lastFailureReportedAt = 0;
  #onDevServerStart: ((command: string) => void) | null = null;
  /**
   * The first step in this artifact that failed, if any.
   *
   * Kept so a command refuses to run behind a broken earlier step rather than
   * executing against an incomplete project and failing invisibly. File writes
   * count: a prod session lost `Create package.json` to a connection timeout,
   * `npm install` ran anyway against a directory with no manifest and exited 254,
   * and the only surviving evidence was a red cross with no stated cause.
   */
  #stepFailure: string | null = null;

  actions: ActionsMap = map({});

  constructor(connect: () => Promise<RuntimeConnection>) {
    this.#connect = connect;
  }

  onDevServerStart(callback: (command: string) => void) {
    this.#onDevServerStart = callback;
  }

  /**
   * Delay all actions until `promise` settles.
   *
   * Used to seed a project template into the workdir before the agent's own
   * file writes run: the template and the generated files share paths (the
   * agent edits main-page.tsx, package.json, etc.), so seeding must land first
   * or it would clobber the agent's work. Chaining onto the execution promise
   * — the same queue every action awaits — guarantees that ordering without a
   * separate lock. A rejected gate is swallowed so a partial seed still lets
   * the agent proceed (more files on disk only helps).
   */
  gateOn(promise: Promise<unknown>) {
    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => promise)
      .then(
        () => undefined,
        () => undefined,
      );
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

    // `.then` derives a new promise from the queue, and a derived promise with no
    // rejection handler is an unhandled rejection of its own — the
    // `Uncaught (in promise) Error: Connection timeout` that accompanied every
    // failed action in prod, even though `runAction` already handles the queue.
    this.#currentExecutionPromise
      .then(() => {
        this.#updateAction(actionId, { status: 'running' });
      })
      .catch(() => {
        // Already reported by the queue in runAction.
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
        this.#reportFailure(error);
      });
  }

  /**
   * Tell the user when actions are failing.
   *
   * Previously this only reached the console, so a sandbox that never connected
   * showed up as a column of red crosses and an empty file tree with no
   * explanation and no hint that reloading would fix it. Reported once per burst
   * because a failed connection fails every action in the artifact, and one clear
   * message is more useful than twenty identical ones.
   */
  #reportFailure(error: unknown) {
    const now = Date.now();

    if (now - this.#lastFailureReportedAt < FAILURE_REPORT_INTERVAL_MS) {
      return;
    }

    this.#lastFailureReportedAt = now;

    const message = error instanceof Error ? error.message : String(error);
    const isConnectivity = /sandbox|session|websocket|connection/i.test(message);

    toast.error(
      isConnectivity
        ? 'Lost connection to the sandbox — reload the page to reconnect.'
        : `Action failed: ${message}`,
      { toastId: 'action-runner-failure' },
    );
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
      // Carry the real reason. A flat 'Action failed' is what made the prod
      // session unreadable: the UI showed which steps failed but never that the
      // first one lost the connection, so the 254 from npm install looked like
      // the root cause instead of a consequence.
      this.#updateAction(actionId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  /**
   * Resolve a connection, retrying a transient failure.
   *
   * `#connect()` rejects with `Connection timeout` when the socket is still
   * coming up or mid-reconnect. Retrying costs a few hundred milliseconds and is
   * the difference between an artifact that builds and one whose first file write
   * is lost — the connection in the prod session recovered on its own, which is
   * why every write after the first succeeded.
   */
  async #connectWithRetry(): Promise<RuntimeConnection> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.#connect();
      } catch (error) {
        lastError = error;
        logger.warn(`Connect attempt ${attempt}/${RETRY_ATTEMPTS} failed:`, error);

        if (attempt < RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
        }
      }
    }

    throw lastError;
  }

  async #runShellAction(action: ActionState) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }

    // Running any command after an earlier step in this artifact failed is how a
    // lost write or a failed install turns into a silent dead end: the earlier
    // step rejected, the queue swallowed it, and the command ran against a project
    // that was never fully written. Refuse before even connecting, and say which
    // step to look at.
    if (this.#stepFailure) {
      throw new Error(
        isDevServerCommand(action.content)
          ? `Not starting the dev server: an earlier step failed (${this.#stepFailure})`
          : `Not running "${action.content}": an earlier step failed (${this.#stepFailure})`,
      );
    }

    const conn = await this.#connectWithRetry();

    if (isDevServerCommand(action.content)) {
      await this.#startDevServer(conn, action.content);

      return;
    }

    let response: ShellExecResponse;

    try {
      response = await conn.request<ShellExecResponse>(
        {
          type: 'shell:exec:req',
          payload: {
            command: action.content,
            env: { npm_config_yes: 'true' },
            streamOutput: true,
          },
        },
        SHELL_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // A timeout leaves the command still running in the container with no way to
      // know how far it got, so anything depending on it must not start.
      this.#stepFailure = `${action.content} did not report back`;
      throw error;
    }

    const exitCode = response.payload.exitCode;

    logger.debug(`Process terminated with code ${exitCode}`);

    if (exitCode !== 0) {
      this.#stepFailure = `${action.content} exited ${exitCode}`;
      throw new Error(`Command failed with exit code ${exitCode}: ${action.content}`);
    }
  }

  /**
   * Start a dev server and wait for it to actually serve.
   *
   * A dev server never exits, so the command cannot be awaited; the port opening
   * is the only evidence it worked. Previously this raced the port against a
   * timeout and then returned either way, so a server that never bound still
   * reported `complete` — a green tick over a preview pane that would spin
   * forever. Timing out is a failure now, and carries the reason.
   */
  async #startDevServer(conn: RuntimeConnection, command: string) {
    this.#onDevServerStart?.(command);

    let onPort: (() => void) | undefined;

    const portOpened = new Promise<true>((resolve) => {
      onPort = () => resolve(true);
      conn.on('port:open:event', onPort);
    });

    conn
      .request<ShellExecResponse>(
        {
          type: 'shell:exec:req',
          payload: {
            command,
            env: { npm_config_yes: 'true' },
            streamOutput: true,
          },
        },
        SHELL_REQUEST_TIMEOUT_MS,
      )
      .catch(() => {
        // A dev server outliving its request is the normal case, not a failure.
      });

    const timedOut = new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), DEV_SERVER_PORT_TIMEOUT_MS),
    );

    try {
      if (await Promise.race([portOpened, timedOut])) {
        logger.debug('Dev server opened a port');
        return;
      }
    } finally {
      if (onPort) {
        conn.off('port:open:event', onPort);
      }
    }

    this.#stepFailure = `${command} never opened a port`;
    throw new Error(
      `The dev server did not start within ${Math.round(DEV_SERVER_PORT_TIMEOUT_MS / 1000)}s: ${command}`,
    );
  }

  /**
   * Write one file, retrying a lost attempt and failing loudly if it never lands.
   *
   * This used to catch its own errors and only log them, so a write that never
   * happened still marked the action `complete`. That is how a prod session
   * produced a project with no `package.json` and a green tick over the step that
   * was supposed to create it.
   *
   * Retrying is safe here in a way it is not for shell commands: writing the same
   * content twice is idempotent, whereas re-running `npm install` because its
   * response was slow is worse than failing.
   */
  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        await this.#writeFile(action.filePath, action.content);
        return;
      } catch (error) {
        lastError = error;
        logger.warn(`Write of ${action.filePath} failed (attempt ${attempt}/${RETRY_ATTEMPTS}):`, error);

        if (attempt < RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
        }
      }
    }

    // Poison the artifact so nothing builds on a file that is not there. Later
    // writes still run — more files on disk can only help, and refusing them
    // would hide how much of the project actually made it.
    this.#stepFailure ??= `writing ${action.filePath} failed`;

    throw lastError;
  }

  async #writeFile(filePath: string, content: string) {
    const conn = await this.#connectWithRetry();

    // Ensure parent directory exists
    let folder = nodePath.dirname(filePath);
    folder = folder.replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await conn.request({
          type: 'fs:mkdir:req',
          payload: { path: folder },
        });
        logger.debug('Created folder', folder);
      } catch (error) {
        // Not fatal on its own: the directory may already exist, and the write
        // below is the operation that decides whether this step worked.
        logger.warn('Failed to create folder\n\n', error);
      }
    }

    await conn.request({
      type: 'fs:write:req',
      payload: {
        path: filePath,
        content,
        encoding: 'utf8',
      },
    });

    logger.debug(`File written ${filePath}`);
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }
}
