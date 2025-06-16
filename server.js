require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api'); // Add Telegram bot import

const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

// Telegram Bot setup
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096; // Telegram message limit

let lastSummary = null; // Store the full transcription
let originalSummary = null; // Store the original summary
let awaitingAmendment = false; // Track if waiting for amendment instruction

// Function to split a long text into multiple messages
function splitMessage(text, maxLength = MAX_TELEGRAM_MESSAGE_LENGTH) {
  const messages = [];
  for (let i = 0; i < text.length; i += maxLength) {
    messages.push(text.substring(i, i + maxLength));
  }
  return messages;
}

// Listen for Telegram messages to update the summary or amend it
bot.on('message', async msg => {
  if (msg.chat && msg.chat.id && msg.chat.id.toString() === TELEGRAM_CHAT_ID) {
    if (msg.text && msg.text.trim() === '/transcription') {
      if (lastSummary) {
        const messages = splitMessage(lastSummary);
        for (const message of messages) {
          await bot.sendMessage(TELEGRAM_CHAT_ID, `Transcription:\n\n${message}`);
        }
        return;
      } else {
        bot.sendMessage(TELEGRAM_CHAT_ID, 'No transcription available yet. Please upload an audio file first.');
        return;
      }
    }
    if (lastSummary !== null && msg.text && msg.text.trim() === '/amend') {
      awaitingAmendment = true;
      bot.sendMessage(TELEGRAM_CHAT_ID, 'Amendment mode enabled. Please send the amendment instructions for the summary.');
      return;
    }
    if (lastSummary !== null && awaitingAmendment && msg.text && msg.text.trim() !== '/amend') {
      const userPrompt = msg.text.trim();
      awaitingAmendment = false;
      // Compose amendment prompt for Gemini
      const amendPrompt = `Here is the current summary:\n${originalSummary}\n\nAmend the summary according to this instruction: ${userPrompt}\n\nReturn only the revised summary.`;
      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              { text: amendPrompt }
            ],
          },
        ],
      };
      try {
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const errorData = await response.json();
          bot.sendMessage(TELEGRAM_CHAT_ID, `Gemini API error: ${errorData.error.message}`);
          return;
        }
        const result = await response.json();
        if (
          result.candidates &&
          result.candidates.length > 0 &&
          result.candidates[0].content &&
          result.candidates[0].content.parts &&
          result.candidates[0].content.parts.length > 0
        ) {
          originalSummary = result.candidates[0].content.parts[0].text.trim();
          bot.sendMessage(TELEGRAM_CHAT_ID, `Summary amended:\n\n${originalSummary}`);

          // Regenerate the summary for conciseness and freshness
          const regenPrompt = `Please summarize the following text, making it concise and clear:\n${originalSummary}\n\nReturn only the summary.`;
          const regenPayload = {
            contents: [
              {
                role: "user",
                parts: [
                  { text: regenPrompt }
                ],
              },
            ],
          };
          try {
            const regenResponse = await fetch(API_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(regenPayload),
            });
            if (!regenResponse.ok) {
              const errorData = await regenResponse.json();
              bot.sendMessage(TELEGRAM_CHAT_ID, `Gemini API error during regeneration: ${errorData.error.message}`);
              return;
            }
            const regenResult = await regenResponse.json();
            if (
              regenResult.candidates &&
              regenResult.candidates.length > 0 &&
              regenResult.candidates[0].content &&
              regenResult.candidates[0].content.parts &&
              regenResult.candidates[0].content.parts.length > 0
            ) {
              originalSummary = regenResult.candidates[0].content.parts[0].text.trim();
              bot.sendMessage(TELEGRAM_CHAT_ID, `Regenerated summary:\n\n${originalSummary}`);
            } else {
              bot.sendMessage(TELEGRAM_CHAT_ID, 'Gemini API did not return a regenerated summary.');
            }
          } catch (regenErr) {
            bot.sendMessage(TELEGRAM_CHAT_ID, `Error regenerating summary: ${regenErr.message}`);
          }
        } else {
          bot.sendMessage(TELEGRAM_CHAT_ID, 'Gemini API did not return an amended summary.');
        }
      } catch (err) {
        bot.sendMessage(TELEGRAM_CHAT_ID, `Error amending summary: ${err.message}`);
      }
      return;
    }
    if (msg.text && msg.text.startsWith('/ask')) {
      const question = msg.text.replace('/ask', '').trim();
      if (!question) {
        bot.sendMessage(TELEGRAM_CHAT_ID, 'Please provide a question after /ask.');
        return;
      }

      if (!lastSummary || !originalSummary) {
        bot.sendMessage(TELEGRAM_CHAT_ID, 'Please upload an audio file first to generate a summary and transcription.');
        return;
      }

      const combinedText = `Transcription:\n${lastSummary}\n\nSummary:\n${originalSummary}\n\nQuestion: ${question}\n\nAnswer:`;

      const askPayload = {
        contents: [{
          role: "user",
          parts: [{
            text: combinedText
          }]
        }],
      };

      try {
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const askResponse = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(askPayload),
        });

        if (!askResponse.ok) {
          const errorData = await askResponse.json();
          bot.sendMessage(TELEGRAM_CHAT_ID, `Gemini API error: ${errorData.error.message}`);
          return;
        }

        const askResult = await askResponse.json();

        if (askResult.candidates &&
          askResult.candidates.length > 0 &&
          askResult.candidates[0].content &&
          askResult.candidates[0].content.parts &&
          askResult.candidates[0].content.parts.length > 0
        ) {
          const answer = askResult.candidates[0].content.parts[0].text.trim();
          bot.sendMessage(TELEGRAM_CHAT_ID, `Answer:\n\n${answer}`);
        } else {
          bot.sendMessage(TELEGRAM_CHAT_ID, 'Gemini API did not return an answer.');
        }
      } catch (askError) {
        console.error(`Error calling Gemini API for question: ${askError.message}`);
        bot.sendMessage(TELEGRAM_CHAT_ID, `Error answering question: ${askError.message}`);
      }
      return;
    }
    if (lastSummary !== null && !awaitingAmendment && msg.text && !msg.text.startsWith('/')) {
      originalSummary = msg.text;
      bot.sendMessage(TELEGRAM_CHAT_ID, `Summary updated:\n\n${originalSummary}`);
    }
  }
});

const app = express();
const fifteenMB = 15 * 1024 * 1024; // 15 MB in bytes

const MAX_CONCURRENT_REQUESTS = 5; // Limit simultaneous requests
let currentConcurrentRequests = 0;

const upload = multer({
  storage: multer.memoryStorage(), // Use memory storage
  limits: { fileSize: fifteenMB }
});

// Add a root endpoint for a quick health check
app.get('/', (req, res) => {
  res.send('Server is running');
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (currentConcurrentRequests >= MAX_CONCURRENT_REQUESTS) {
    return res.status(429).json({ error: 'Too many simultaneous requests. Please try again later.' });
  }
  currentConcurrentRequests++;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded.' });
    }

    const originalName = req.file.originalname;
    let base64Audio, mimeType;

    try {
      if (!req.file.buffer) {
        return res.status(500).json({ error: 'File buffer not available.' });
      }
      base64Audio = req.file.buffer.toString('base64'); // Get data from buffer

      if (originalName.endsWith('.mp3')) {
        mimeType = 'audio/mpeg';
      } else if (originalName.endsWith('.wav')) {
        mimeType = 'audio/wav';
      } else if (originalName.endsWith('.flac')) {
        mimeType = 'audio/flac';
      } else if (originalName.endsWith('.m4a')) {
        mimeType = 'audio/mp4';
      } else {
        return res.status(400).json({ error: "Unsupported audio file type. Please use .mp3, .wav, .flac, or .m4a." });
      }
    } catch (error) {
      console.error(`Error processing audio file from memory: ${error.message}`);
      return res.status(500).json({ error: `Error processing audio file: ${error.message}` });
    }
s
    const prompt = `Transcribe the audio conversation provided. Include all speakers and their dialogue.`;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio,
              },
            },
          ],
        },
      ],
    };

    try {
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        return res.status(500).json({ error: errorData.error.message });
      }

      const result = await response.json();

      if (
        result.candidates &&
        result.candidates.length > 0 &&
        result.candidates[0].content &&
        result.candidates[0].content.parts &&
        result.candidates[0].content.parts.length > 0
      ) {
        const text = result.candidates[0].content.parts[0].text.trim();
        lastSummary = text; // Store the full transcription

        // Generate a summary of the transcription
        const summaryPrompt = `Summarize the following text:\n${text}\n\nReturn only the summary.`;
        const summaryPayload = {
          contents: [
            {
              role: "user",
              parts: [
                { text: summaryPrompt }
              ],
            },
          ],
        };
        try {
          const summaryResponse = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(summaryPayload),
          });
          if (!summaryResponse.ok) {
            const errorData = await summaryResponse.json();
            return res.status(500).json({ error: errorData.error.message });
          }
          const summaryResult = await summaryResponse.json();
          if (
            summaryResult.candidates &&
            summaryResult.candidates.length > 0 &&
            summaryResult.candidates[0].content &&
            summaryResult.candidates[0].content.parts &&
            summaryResult.candidates[0].content.parts.length > 0
          ) {
            originalSummary = summaryResult.candidates[0].content.parts[0].text.trim();
            const summaryMessages = splitMessage(originalSummary);
            let fullMessage = `Summary:\n\n`;
            for (const message of summaryMessages) {
              fullMessage += message;
            }
            const transcriptionMessage = `\n\nUse /transcription to view the full transcription.`;
            const combinedMessage = fullMessage + transcriptionMessage;
            const combinedMessages = splitMessage(combinedMessage);

            for (const message of combinedMessages) {
              await bot.sendMessage(TELEGRAM_CHAT_ID, message);
            }
            return res.json({ message: "Summary sent to Telegram successfully." });
          } else {
            return res.status(500).json({ error: "Gemini API response did not contain expected summary content.", raw: summaryResult });
          }
        } catch (summaryError) {
          console.error(`Error calling Gemini API for summary: ${summaryError.message}`);
          return res.status(500).json({ error: `Error calling Gemini API for summary: ${summaryError.message}` });
        }
      } else {
        return res.status(500).json({ error: "Gemini API response did not contain expected content.", raw: result });
      }
    } catch (error) {
      return res.status(500).json({ error: `Error calling Gemini API: ${error.message}` });
    }
  } finally {
    currentConcurrentRequests--;
  }
});

// Optional: Add an endpoint to get the current summary
app.get('/summary', (req, res) => {
  if (lastSummary === null) {
    return res.status(404).json({ error: 'No summary available.' });
  }
  res.json({ summary: lastSummary });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RESTful API server listening on port ${PORT}`);
});