type Pipenet = typeof import("pipenet").pipenet;

const MISSING_PIPENET_MESSAGE = [
  "Error: --tunnel requires the optional 'pipenet' package, which is not installed.",
  "Install it with: npm install pipenet",
  "For a global install: npm install -g mcp-proxy pipenet",
  "See https://github.com/punkpeye/mcp-proxy#public-tunnel for details.",
].join("\n");

export type { Pipenet };

export class PipenetNotInstalledError extends Error {
  constructor() {
    super(MISSING_PIPENET_MESSAGE);
    this.name = "PipenetNotInstalledError";
  }
}

export const isMissingPipenet = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }

  return /Cannot find (?:package|module) ['"]pipenet['"]/.test(error.message);
};

// pipenet is an optional peer dependency: only --tunnel needs it, and library
// consumers should not install its tree (axios, koa, yargs) just to use the
// proxy. Import it lazily and turn a missing install into an actionable error
// instead of a bare ERR_MODULE_NOT_FOUND.
export const loadPipenet = async (
  importPipenet: () => Promise<{ pipenet: Pipenet }> = () => import("pipenet"),
): Promise<Pipenet> => {
  try {
    const { pipenet } = await importPipenet();

    return pipenet;
  } catch (error) {
    if (!isMissingPipenet(error)) {
      throw error;
    }

    throw new PipenetNotInstalledError();
  }
};
