import { CopilotClient, defineTool } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();
const session = await client.createSession({
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
