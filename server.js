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

// Root folder for all projects
const PROJECTS_ROOT = path.join(__dirname, 'projects');
if (!fs.existsSync(PROJECTS_ROOT)) {
  fs.mkdirSync(PROJECTS_ROOT);
}

// Serve projects statically so we can load e.g. /projects/{id}/index.html
app.use('/projects', express.static(PROJECTS_ROOT));

// Our in-memory structure:
// projectsData[projectId] = {
//   conversation: [...], // array of { role, content }
//   files: { "filePath": "file content" }
// }
const projectsData = {};

/**
 * Helper: generate a projectId
 */
function generateId() {
  return Math.random().toString(36).substring(2, 8) + Date.now().toString(36);
}

/**
 * Return a list of existing projects from the /projects folder
 * (We also check if we have them in memory. In production,
 * you might store project metadata in a DB.)
 */
app.get('/list-projects', (req, res) => {
  const dirs = fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  // For convenience, show only ones we know in memory
  // or everything on disk (whichever you prefer)
  const projectsInMemory = Object.keys(projectsData);
  const result = dirs.map((name) => ({
    projectId: name,
    inMemory: projectsInMemory.includes(name),
  }));

  res.json({ projects: result });
});

/**
 * Create a new project
 * We set up a system instruction describing how we want new vs. existing files handled.
 */
app.post('/create-project', (req, res) => {
  const { projectName } = req.body;
  const projectId = projectName
    ? projectName.replace(/\s+/g, '_') + '_' + generateId()
    : 'project_' + generateId();

  const projectPath = path.join(PROJECTS_ROOT, projectId);
  fs.mkdirSync(projectPath, { recursive: true });

  // Start conversation
  // System instructions:
  //  - If a file doesn't exist, provide "files": [...]
  //  - If a file does exist, provide "patches": [...]
  //  - Possibly also "commands": [...]
  //  - No extra text outside JSON.
  const systemMessage = `
You are an advanced coding assistant. You have an existing project that can contain files. You can do two types of file operations:

1) "files": [
   { "path": "<newFilePath>", "content": "<entire file content>" }
]
   - For brand-new files that do not exist yet.

2) "patches": [
   {
     "file": "<existingFilePath>",
     "instructions": [
       {
         "lineNumber": 12,
         "oldText": "...",
         "newText": "..."
       }
       // additional instructions
     ]
   }
]
   - For incremental changes to existing files. Each instruction references a specific line number and modifies it.

You must decide whether to place a file in "files" if it does not exist, or in "patches" if it already exists. Also, you can specify commands as:
  "commands": ["npm install", "node server.js"]

Return ONLY valid JSON with this shape:
{
  "files": [...],
  "patches": [...],
  "commands": [...]
}
No extra text or formatting outside the JSON!
`.trim();

  projectsData[projectId] = {
    conversation: [
      { role: 'system', content: systemMessage },
    ],
    files: {}, // no initial files
  };

  res.json({ projectId });
});

/**
 * Resume/Load an existing project into memory so we can continue from where we left off.
 * We read all files from disk so we have them in memory,
 * and keep the system message from before (or re-generate a new one).
 */
app.post('/load-project', (req, res) => {
  const { projectId } = req.body;
  const projectPath = path.join(PROJECTS_ROOT, projectId);
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project folder not found.' });
  }

  // If we already have it in memory, do nothing
  if (!projectsData[projectId]) {
    // Build a new system message or store an existing one. For simplicity, re-generate:
    const systemMessage = `
You are an advanced coding assistant. ...
(Same instructions about "files" vs. "patches".)
`.trim();

    projectsData[projectId] = {
      conversation: [
        { role: 'system', content: systemMessage },
      ],
      files: {},
    };

    // Read all existing files into memory
    // This is a naive "recursive" approach if you have subfolders:
    function readAllFiles(dir, relative = '') {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          readAllFiles(path.join(dir, item.name), path.join(relative, item.name));
        } else {
          const filePath = path.join(relative, item.name);
          const content = fs.readFileSync(path.join(dir, item.name), 'utf8');
          projectsData[projectId].files[filePath] = content;
        }
      }
    }
    readAllFiles(projectPath, '');
  }

  res.json({ projectId, status: 'Project loaded into memory' });
});

/**
 * Update project with a new prompt (SSE streaming)
 */
app.post('/update-project', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { projectId, prompt } = req.body;
  const projectState = projectsData[projectId];
  if (!projectState) {
    sendSSE(res, 'status', { status: 'Invalid projectId or not loaded in memory' });
    return res.end();
  }
  if (!prompt) {
    sendSSE(res, 'status', { status: 'Empty prompt' });
    return res.end();
  }

  // Build a file context message: show line numbers for each existing file
  let fileContext = `Here are the current files with line numbers:\n\n`;
  for (const [filePath, content] of Object.entries(projectState.files)) {
    fileContext += `File: ${filePath}\n`;
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      fileContext += `${idx + 1}: ${line}\n`;
    });
    fileContext += `\n`;
  }

  const conversation = [
    ...projectState.conversation,
    { role: 'system', content: fileContext },
    { role: 'user', content: prompt },
  ];

  sendSSE(res, 'status', { status: 'Contacting OpenAI...' });

  let fullResponse = '';
  try {
    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: conversation,
      stream: true,
      response_format: { "type": "json_object" }
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        // Typewriter or partial SSE
        sendSSE(res, 'partial', { text });
      }
    }
  } catch (err) {
    sendSSE(res, 'status', { status: 'ERROR: ' + err.message });
    return res.end();
  }

  // Try to parse JSON
  let parsed;
  try {
    parsed = JSON.parse(fullResponse);
    // Save the AI response to conversation
    projectState.conversation.push({ role: 'assistant', content: fullResponse });
  } catch (err) {
    sendSSE(res, 'status', { status: 'ERROR: Could not parse JSON. ' + err.message });
    return res.end();
  }

  const filesArray = parsed.files || [];
  const patchesArray = parsed.patches || [];
  const commandsArray = parsed.commands || [];

  // Write brand-new files
  if (filesArray.length > 0) {
    for (const f of filesArray) {
      const filePath = f.path;
      const content = f.content;
      // If it already exists, we can decide to overwrite or ignore. 
      // But the instructions say "files" are for brand-new files, so let's just write.
      projectState.files[filePath] = content;
      const onDisk = path.join(PROJECTS_ROOT, projectId, filePath);
      fs.mkdirSync(path.dirname(onDisk), { recursive: true });
      fs.writeFileSync(onDisk, content, 'utf8');
      sendSSE(res, 'file-written', { path: filePath });
    }
  }

  // Apply patches to existing files
  if (patchesArray.length > 0) {
    for (const p of patchesArray) {
      const filePath = p.file;
      const instructions = p.instructions || [];

      if (!projectState.files[filePath]) {
        // If the file doesn't exist, we can't patch it. We could skip or warn.
        sendSSE(res, 'status', {
          status: `ERROR: Trying to patch nonexistent file ${filePath}.`,
        });
        continue;
      }
      let lines = projectState.files[filePath].split('\n');

      for (const instr of instructions) {
        const lineIndex = instr.lineNumber - 1;
        if (lineIndex < 0 || lineIndex >= lines.length) {
          sendSSE(res, 'status', {
            status: `ERROR: lineNumber ${instr.lineNumber} out of range for ${filePath}`,
          });
          continue;
        }
        // check if oldText matches
        if (!lines[lineIndex].includes(instr.oldText)) {
          sendSSE(res, 'status', {
            status: `WARNING: oldText not found in line ${instr.lineNumber} for ${filePath}. Replacing entire line anyway.`,
          });
        }
        // do the replacement
        lines[lineIndex] = lines[lineIndex].replace(instr.oldText, instr.newText);
      }

      const newContent = lines.join('\n');
      projectState.files[filePath] = newContent;
      const onDisk = path.join(PROJECTS_ROOT, projectId, filePath);
      fs.writeFileSync(onDisk, newContent, 'utf8');
      sendSSE(res, 'file-patched', { file: filePath, instructions: instructions.length });
    }
  }

  // Run commands if any
  if (commandsArray.length > 0) {
    const projDir = path.join(PROJECTS_ROOT, projectId);
    for (const cmd of commandsArray) {
      try {
        await runCommand(cmd, projDir, (line) => {
          sendSSE(res, 'command-output', { command: cmd, output: line });
        });
      } catch (err) {
        sendSSE(res, 'status', { status: `Command "${cmd}" failed: ${err.message}` });
      }
    }
  }

  // Done
  sendSSE(res, 'status', { status: 'Done' });
  sendSSE(res, 'done', { projectId });
  res.end();
});

/**
 * Run command in project folder
 */
function runCommand(cmd, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = cmd.split(' ');
    const child = spawn(executable, args, { cwd, shell: true });
    child.stdout.on('data', (d) => onLine(d.toString()));
    child.stderr.on('data', (d) => onLine(d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}`));
    });
  });
}

/**
 * SSE helper
 */
function sendSSE(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Serve the main front-end
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
