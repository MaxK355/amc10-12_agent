// Smoke test for the model backend: sends one tool-using prompt.
// Works with either the logged-in Copilot user (default) or a custom provider
// configured in .env (DASHSCOPE_API_KEY, or TUTOR_BASE_URL + TUTOR_API_KEY).
// Usage: node scripts/sdk-smoke.mjs
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { providerConfig, DEFAULT_MODEL } from "../server/tutor.mjs";

const provider = providerConfig();
const model = process.env.TUTOR_MODEL ?? DEFAULT_MODEL;
console.log(provider ? `Using custom provider ${provider.baseUrl}${model ? ` (${model})` : ""}` : "Using logged-in Copilot user");

const client = new CopilotClient();
await client.start();
const session = await client.createSession({
  ...(model ? { model } : {}),
  ...(provider ? { provider } : {}),
  availableTools: ["custom:*"],
  onPermissionRequest: () => ({ kind: "reject" }),
  systemMessage: { mode: "append", content: "You are a math tutor. Use tools when helpful." },
  tools: [
    defineTool("get_secret_number", {
      description: "Returns the learner's favorite number",
      parameters: { type: "object", properties: {} },
      skipPermission: true,
      handler: () => ({ number: 42 }),
    }),
  ],
});
session.on("tool.execution_start", (e) => console.log("TOOL:", e.data.toolName));
const res = await session.sendAndWait({ prompt: "What is my favorite number squared? Use the tool." }, 120000);
console.log("ANSWER:", res?.data?.content);
await session.disconnect();
await client.stop();
