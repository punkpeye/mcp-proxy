import type { Client } from "@modelcontextprotocol/client";

/**
 * Calls `onExit` when the upstream connection closes without the proxy having
 * asked for it - a stdio server that crashed, was killed or exited on its own.
 *
 * The proxy holds one upstream client for every downstream session, and that
 * client is never reconnected. Once its transport closes, every request in
 * every session, including the ones initialized afterwards, fails with "Not
 * connected" while the process keeps running and looks healthy (#112). The CLI
 * uses this to shut down with a non-zero exit code instead, so the process
 * supervisor that runs it can restart it.
 *
 * `isClosing` must return true once the proxy starts its own shutdown, so a
 * deliberate `client.close()` is not reported as an upstream exit. An
 * `onclose` handler already installed on the client keeps running.
 */
export const watchUpstreamExit = ({
  client,
  isClosing,
  onExit,
}: {
  client: Pick<Client, "onclose">;
  isClosing: () => boolean;
  onExit: () => void;
}) => {
  const previous = client.onclose;
  let reported = false;

  client.onclose = () => {
    previous?.();

    if (reported || isClosing()) {
      return;
    }

    reported = true;
    onExit();
  };
};
