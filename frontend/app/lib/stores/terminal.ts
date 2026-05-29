import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { coloredText } from '~/utils/terminal';
import type { RuntimeConnection, TerminalCreateResponse, TerminalOutputEvent } from '~/lib/runtime/types';

interface ContainerTerminal {
  terminal: ITerminal;
  terminalId: string;
}

export class TerminalStore {
  #connection: Promise<RuntimeConnection>;
  #terminals: ContainerTerminal[] = [];

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(false);

  constructor(connectionPromise: Promise<RuntimeConnection>) {
    this.#connection = connectionPromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  async attachTerminal(terminal: ITerminal) {
    try {
      const conn = await this.#connection;

      // Create terminal on the sidecar
      const response = await conn.request<TerminalCreateResponse>({
        type: 'terminal:create:req',
        payload: {
          cols: terminal.cols ?? 80,
          rows: terminal.rows ?? 24,
        },
      });

      const terminalId = response.payload.terminalId;
      this.#terminals.push({ terminal, terminalId });

      // Listen for terminal output
      const outputHandler = (msg: any) => {
        const event = msg as TerminalOutputEvent;
        if (event.payload.terminalId === terminalId) {
          try {
            const data = atob(event.payload.data);
            terminal.write(data);
          } catch {
            terminal.write(event.payload.data);
          }
        }
      };

      conn.on('terminal:output:event', outputHandler);

      // Forward terminal input to sidecar
      terminal.onData((data: string) => {
        conn.request({
          type: 'terminal:input:req',
          payload: {
            terminalId,
            data: btoa(data),
          },
        }).catch(() => {});
      });
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
      return;
    }
  }

  async onTerminalResize(cols: number, rows: number) {
    const conn = await this.#connection;

    for (const { terminalId } of this.#terminals) {
      conn.request({
        type: 'terminal:resize:req',
        payload: { terminalId, cols, rows },
      }).catch(() => {});
    }
  }
}
