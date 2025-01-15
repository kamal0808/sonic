//////////////////////////////
// server.js
//////////////////////////////
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Configuration, OpenAIApi } = require('openai');
const { getChatCompletion } = require('./services/azureOpenAI');


const app = express();
app.use(express.json());
app.use(cors());

// Initialize OpenAI
// const configuration = new Configuration({
//   apiKey: process.env.OPENAI_API_KEY,
// });
// const openai = new OpenAIApi(configuration);

// In-memory conversation logs (for demonstration purposes)
let conversationHistory = [];

/**
 * POST /generate
 * Body: { prompt: string, relevantCode?: string }
 * 
 * 1. Takes the user's prompt + relevant code from the client
 * 2. Sends them to OpenAI's Chat Completion API
 * 3. Returns the generated code to the client
 */
app.post('/generate', async (req, res) => {
  try {
    const { prompt, relevantCode } = req.body;

    // Keep track of the conversation. 
    // (You can refine this structure as needed.)
    if (prompt) {
      conversationHistory.push({ role: 'user', content: prompt });
    }
    if (relevantCode) {
      // Optionally, you can treat relevant code as additional context.
      conversationHistory.push({ role: 'user', content: relevantCode });
    }

    // Query OpenAI (ChatCompletion) with our conversation so far
    const generatedCode = await getChatCompletion(conversationHistory);

    // Extract the response text
    // const generatedCode = response.data.choices[0].message.content;

    // We can store the assistant's reply back into conversation
    conversationHistory.push({ role: 'assistant', content: generatedCode });

    // Send the generated code as the response
    res.json({ code: generatedCode });
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    res.status(500).json({ error: 'An error occurred while calling OpenAI API' });
  }
});

/**
 * (Optional) Endpoint to clear conversation if needed
 */
app.post('/clear', (req, res) => {
  conversationHistory = [];
  res.json({ message: 'Conversation cleared' });
});


// Serve the index.html directly from the server (so we can run everything easily)
const path = require('path');
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
