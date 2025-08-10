/**
 * Forked from https://github.com/modelcontextprotocol/typescript-sdk/blob/a1608a6513d18eb965266286904760f830de96fe/src/client/stdio.ts
 */

import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ChildProcess, IOType, spawn } from "node:child_process";
import { PassThrough, Stream } from "node:stream";

import { JSONFilterTransform } from "./JSONFilterTransform.js";

export type StdioServerParameters = {
  /**
   * Command line arguments to pass to the executable.
   */
  args?: string[];

  /**
   * The executable to run to start the server.
   */
  command: string;

  /**
   * The working directory to use when spawning the process.
   *
   * If not specified, the current working directory will be inherited.
   */
  cwd?: string;

  /**
   * The environment to use when spawning the process.
   *
   * If not specified, the result of getDefaultEnvironment() will be used.
   */
  env: Record<string, string>;

  /**
   * A function to call when an event occurs.
   */
  onEvent?: (event: TransportEvent) => void;

  /**
   * When true, spawn the child process using the user's shell.
   */
  shell?: boolean;

  /**
   * How to handle stderr of the child process. This matches the semantics of Node's `child_process.spawn`.
   *
   * The default is "inherit", meaning messages to stderr will be printed to the parent process's stderr.
   */
  stderr?: IOType | number | Stream;
};

type TransportEvent =
  | {
      chunk: string;
      type: "data";
    }
  | {
      error: Error;
      type: "error";
    }
  | {
      message: JSONRPCMessage;
      type: "message";
    }
  | {
      type: "close";
    };

/**
 * Client transport for stdio: this will connect to a server by spawning a process and communicating with it over stdin/stdout.
 *
 * This transport is only available in Node.js environments.
 */
export class StdioClientTransport implements Transport {
  onclose?: () => void;

  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /**
   * The child process pid spawned by this transport.
   *
   * This is only available after the transport has been started.
   */
  get pid(): null | number {
    return this._process?.pid ?? null;
  }
  /**
   * The stderr stream of the child process, if `StdioServerParameters.stderr` was set to "pipe" or "overlapped".
   *
   * If stderr piping was requested, a PassThrough stream is returned _immediately_, allowing callers to
   * attach listeners before the start method is invoked. This prevents loss of any early
   * error output emitted by the child process.
   */
  get stderr(): null | Stream {
    if (this._stderrStream) {
      return this._stderrStream;
    }

    return this._process?.stderr ?? null;
  }
  private _abortController: AbortController = new AbortController();
  private _process?: ChildProcess;
  private _readBuffer: ReadBuffer = new ReadBuffer();
  private _serverParams: StdioServerParameters;
  private _stderrStream: null | PassThrough = null;

  private onEvent?: (event: TransportEvent) => void;

  constructor(server: StdioServerParameters) {
    this._serverParams = server;
    if (server.stderr === "pipe" || server.stderr === "overlapped") {
      this._stderrStream = new PassThrough();
    }
    this.onEvent = server.onEvent;
  }

  async close(): Promise<void> {
    this.onEvent?.({
      type: "close",
    });

    this._abortController.abort();
    this._process = undefined;
    this._readBuffer.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (!this._process?.stdin) {
        throw new Error("Not connected");
      }

      const json = serializeMessage(message);
      if (this._process.stdin.write(json)) {
        resolve();
      } else {
        this._process.stdin.once("drain", resolve);
      }
    });
  }

  /**
   * Starts the server process and prepares to communicate with it.
   */
  async start(): Promise<void> {
    if (this._process) {
      throw new Error(
        "StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.",
      );
    }

    return new Promise((resolve, reject) => {
      this._process = spawn(
        this._serverParams.command,
        this._serverParams.args ?? [],
        {
          cwd: this._serverParams.cwd,
          env: this._serverParams.env,
          shell: this._serverParams.shell ?? false,
          signal: this._abortController.signal,
          stdio: ["pipe", "pipe", this._serverParams.stderr ?? "inherit"],
        },
      );

      this._process.on("error", (error) => {
        if (error.name === "AbortError") {
          // Expected when close() is called.
          this.onclose?.();
          return;
        }

        reject(error);
        this.onerror?.(error);
      });

      this._process.on("spawn", () => {
        resolve();
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this._process.on("close", (_code) => {
        this.onEvent?.({
          type: "close",
        });

        this._process = undefined;
        this.onclose?.();
      });

      this._process.stdin?.on("error", (error) => {
        this.onEvent?.({
          error,
          type: "error",
        });

        this.onerror?.(error);
      });

      const jsonFilterTransform = new JSONFilterTransform();

      this._process.stdout?.pipe(jsonFilterTransform);

      jsonFilterTransform.on("data", (chunk) => {
        this.onEvent?.({
          chunk: chunk.toString(),
          type: "data",
        });

        this._readBuffer.append(chunk);
        this.processReadBuffer();
      });

      jsonFilterTransform.on("error", (error) => {
        this.onEvent?.({
          error,
          type: "error",
        });

        this.onerror?.(error);
      });

      if (this._stderrStream && this._process.stderr) {
        this._process.stderr.pipe(this._stderrStream);
      }
    });
  }

  private processReadBuffer() {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();

        if (message === null) {
          break;
        }

        this.onEvent?.({
          message,
          type: "message",
        });

        this.onmessage?.(message);
      } catch (error) {
        this.onEvent?.({
          error: error as Error,
          type: "error",
        });

        this.onerror?.(error as Error);
      }
    }
  }
}
