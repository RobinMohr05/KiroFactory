import { Router, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

// Resolve the .kiro/agents directory relative to project root
function getAgentsDir(): string {
  // backend/src/routes/agents.ts → project root is 3 levels up
  return path.resolve(__dirname, "../../../.kiro/agents");
}

function ensureAgentsDir(): void {
  const dir = getAgentsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function agentFilePath(name: string): string {
  // Sanitize: only allow alphanumeric, dashes, underscores
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(getAgentsDir(), `${safeName}.json`);
}

// GET /api/agents — list all agents
router.get("/", (_req: Request, res: Response) => {
  try {
    ensureAgentsDir();
    const dir = getAgentsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const agents = files.map((file) => {
      try {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const parsed = JSON.parse(content);
        return { fileName: file, ...parsed };
      } catch {
        return { fileName: file, name: file.replace(".json", ""), error: "Failed to parse" };
      }
    });
    res.json(agents);
  } catch (err) {
    console.error("GET /api/agents error:", err);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

// GET /api/agents/:name — get a single agent by file name (without .json)
router.get("/:name", (req: Request, res: Response) => {
  try {
    const filePath = agentFilePath(req.params.name as string);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    res.json({ fileName: `${req.params.name}.json`, ...parsed });
  } catch (err) {
    console.error("GET /api/agents/:name error:", err);
    res.status(500).json({ error: "Failed to read agent" });
  }
});

// POST /api/agents — create a new agent
router.post("/", (req: Request, res: Response) => {
  try {
    ensureAgentsDir();
    const body = req.body;

    if (!body.name) {
      res.status(400).json({ error: "Agent name is required" });
      return;
    }

    const filePath = agentFilePath(body.name);
    if (fs.existsSync(filePath)) {
      res.status(409).json({ error: "An agent with this name already exists" });
      return;
    }

    // Write the agent JSON file
    const agentData = {
      name: body.name,
      description: body.description || "",
      prompt: body.prompt || "",
      tools: body.tools || [],
      allowedTools: body.allowedTools || [],
      toolsSettings: body.toolsSettings || {},
      resources: body.resources || [],
    };

    fs.writeFileSync(filePath, JSON.stringify(agentData, null, 2), "utf-8");
    res.status(201).json({ fileName: `${body.name}.json`, ...agentData });
  } catch (err) {
    console.error("POST /api/agents error:", err);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

// PUT /api/agents/:name — update an existing agent
router.put("/:name", (req: Request, res: Response) => {
  try {
    const filePath = agentFilePath(req.params.name as string);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const body = req.body;
    const agentData = {
      name: body.name || req.params.name,
      description: body.description || "",
      prompt: body.prompt || "",
      tools: body.tools || [],
      allowedTools: body.allowedTools || [],
      toolsSettings: body.toolsSettings || {},
      resources: body.resources || [],
    };

    // If name changed, we need to rename the file
    if (body.name && body.name !== req.params.name) {
      const newFilePath = agentFilePath(body.name);
      if (fs.existsSync(newFilePath)) {
        res.status(409).json({ error: "An agent with this new name already exists" });
        return;
      }
      fs.unlinkSync(filePath);
      fs.writeFileSync(newFilePath, JSON.stringify(agentData, null, 2), "utf-8");
      res.json({ fileName: `${body.name}.json`, ...agentData });
    } else {
      fs.writeFileSync(filePath, JSON.stringify(agentData, null, 2), "utf-8");
      res.json({ fileName: `${req.params.name}.json`, ...agentData });
    }
  } catch (err) {
    console.error("PUT /api/agents/:name error:", err);
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// DELETE /api/agents/:name — delete an agent
router.delete("/:name", (req: Request, res: Response) => {
  try {
    const filePath = agentFilePath(req.params.name as string);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/agents/:name error:", err);
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

export default router;
