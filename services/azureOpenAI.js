/**
 * @file azureOpenAI.js
 * @description Interact with Azure OpenAI embeddings
 */

const { AzureOpenAI } = require('openai');
const logger = require('../utils/logger');

const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const apiVersion = process.env.AZURE_OPENAI_VERSION || "2024-05-01-preview";
const client = new AzureOpenAI({endpoint, apiKey,apiVersion});

/**
 * @function getEmbeddingForText
 * @description Get embeddings from Azure OpenAI for a given text
 * @param {string} text - The text to embed
 */
async function getEmbeddingForText(text) {
  logger.info('Requesting embedding for text...');
  // Replace 'your-embedding-deployment-id' with your actual model deployment ID.
  const response = await client.getEmbeddings('your-embedding-deployment-id', [text]);
  return response.data[0].embedding;
}

async function uploadFile(fileStream) {
  const file = await openai.files.create({
    file: fileStream,
    purpose: "assistants",
  });

  console.log(file);
}

async function getChatCompletion(messages) {
  logger.info('Requesting chat completion...');
  // Replace 'your-chat-deployment-id' with your actual model deployment ID.
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: messages,
    // maxTokens: 150, // Adjust as needed
    temperature: 0.7, // Adjust as needed
    response_format: { "type": "json_object" }
  });
  return response.choices[0].message.content;
}


module.exports = { getEmbeddingForText, uploadFile, getChatCompletion };
