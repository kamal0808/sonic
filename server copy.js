/////////////////////////////////////
// server.js
/////////////////////////////////////
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

// Official OpenAI library
const { AzureOpenAI } = require('openai');
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const apiVersion = process.env.AZURE_OPENAI_VERSION || "2024-05-01-preview";
const client = new AzureOpenAI({endpoint, apiKey,apiVersion});


const app = express();
app.use(express.json());
app.use(cors());

// We'll keep a "projects" folder at the root for storing each project
const PROJECTS_DIR = path.join(__dirname, 'projects');
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR);
}

// Serve all projects as static so you can load /projects/{projectId}/index.html
app.use('/projects', express.static(PROJECTS_DIR));

// In-memory store of conversation: { [projectId]: [ ... messages ... ] }
const conversationHistory = {};

/**
 * Generate a simple unique ID
 */
function generateId() {
  return (
    Math.random().toString(36).substring(2, 8) +
    Date.now().toString(36)
  );
}

/**
 * Create/Reset a Project
 */
app.post('/create-project', (req, res) => {
  const { projectName } = req.body;
  const projectId = projectName
    ? projectName.replace(/\s+/g, '_') + '_' + generateId()
    : 'project_' + generateId();

  const projectPath = path.join(PROJECTS_DIR, projectId);
  fs.mkdirSync(projectPath, { recursive: true });

  // Initialize conversation with a system message instructing strict JSON output
  conversationHistory[projectId] = [
    {
      role: 'system',
      content: `You are a coding assistant. Always respond with valid JSON in this format:
{
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html>..." },
    ...
  ],
  "commands": ["npm install", "node server.js"]
}
No extra text outside the JSON!`
    },
  ];

  res.json({ projectId });
});

/**
 * Receive a new prompt to update the code
 * SSE stream partial text for a "typewriter" effect, then parse JSON, write files, run commands
 */
app.post('/update-project', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { projectId, prompt } = req.body;
  if (!projectId || !conversationHistory[projectId]) {
    sendSSE(res, 'status', { status: 'ERROR: Invalid projectId' });
    return res.end();
  }
  if (!prompt) {
    sendSSE(res, 'status', { status: 'ERROR: Prompt is empty' });
    return res.end();
  }

  // Add user prompt to conversation
  conversationHistory[projectId].push({ role: 'user', content: prompt });

  let fullResponse = '';

  try {
    sendSSE(res, 'status', { status: 'Contacting OpenAI...' });

    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: conversationHistory[projectId],
      stream: true,
    });

    sendSSE(res, 'status', { status: 'Receiving code (typewriter mode)...' });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        // Stream partial SSE for typewriter effect
        sendSSE(res, 'partial', { text });
      }
    }

    sendSSE(res, 'status', { status: 'OpenAI response complete. Parsing JSON...' });
  } catch (err) {
    console.error('Error streaming from OpenAI:', err);
    sendSSE(res, 'status', { status: 'ERROR: ' + err.message });
    return res.end();
  }

  // Try parsing the final text as JSON
  let parsed;
  try {
    parsed = JSON.parse(fullResponse);
    // Save assistant response in conversation
    conversationHistory[projectId].push({ role: 'assistant', content: fullResponse });
  } catch (err) {
    sendSSE(res, 'status', {
      status: 'ERROR: Could not parse JSON from response. Possibly invalid format.',
    });
    return res.end();
  }

  const files = parsed.files || [];
  const commands = parsed.commands || [];

  const projectPath = path.join(PROJECTS_DIR, projectId);

  // Write files
  try {
    for (const f of files) {
      const outPath = path.join(projectPath, f.path);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, f.content, 'utf8');
      sendSSE(res, 'file-written', { path: f.path });
    }
  } catch (err) {
    sendSSE(res, 'status', { status: 'ERROR writing files: ' + err.message });
    return res.end();
  }

  // Run commands sequentially
  if (commands.length > 0) {
    sendSSE(res, 'status', { status: 'Running commands...' });
    for (const cmd of commands) {
      try {
        await runCommand(cmd, projectPath, (line) => {
          sendSSE(res, 'command-output', { command: cmd, output: line });
        });
      } catch (err) {
        sendSSE(res, 'status', { status: `Command "${cmd}" failed: ${err.message}` });
        return res.end();
      }
    }
  }

  // Done
  sendSSE(res, 'status', { status: 'Done. Reloading preview...' });
  sendSSE(res, 'done', { projectId });
  res.end();
});

/**
 * Helper: run a shell command in the project folder
 */
function runCommand(cmd, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = cmd.split(' ');
    const child = spawn(executable, args, { cwd, shell: true });

    child.stdout.on('data', (data) => onLine(data.toString()));
    child.stderr.on('data', (data) => onLine(data.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}`));
    });
  });
}

/**
 * Helper: send SSE
 */
function sendSSE(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Serve the main index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
