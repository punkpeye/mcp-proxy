import { startStdioServer } from "../src/startStdioServer.js";

await startStdioServer(JSON.parse(process.argv[2]));
