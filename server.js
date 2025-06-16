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
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

const app = express();
const fifteenMB = 15 * 1024 * 1024; // 15 MB in bytes

const MAX_CONCURRENT_REQUESTS = 5; // Limit simultaneous requests
let currentConcurrentRequests = 0;

const upload = multer({
  storage: multer.memoryStorage(), // Use memory storage
  limits: { fileSize: fifteenMB }
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
      } else {
        return res.status(400).json({ error: "Unsupported audio file type. Please use .mp3, .wav, or .flac." });
      }
    } catch (error) {
      console.error(`Error processing audio file from memory: ${error.message}`);
      return res.status(500).json({ error: `Error processing audio file: ${error.message}` });
    }

    const prompt = `Summarize the audio conversation provided. Include the main topics discussed, key points raised, and any agreed-upon actions or concerns.

Example Output Structure:
Summary:
The conversation focused on project deadlines and resource allocation. Key points included the need for additional team members and agreement on extending the timeline by two weeks.
`;

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
        try {
          await bot.sendMessage(TELEGRAM_CHAT_ID, `Summary:\n\n${text}`);
          return res.json({ message: "Summary sent to Telegram successfully." });
        } catch (telegramError) {
          console.error(`Error sending summary to Telegram: ${telegramError.message}`);
          return res.status(500).json({ error: "Summary generated but failed to send to Telegram.", telegram_error: telegramError.message });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RESTful API server listening on port ${PORT}`);
});