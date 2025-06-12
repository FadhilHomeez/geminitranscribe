const express = require('express');
const multer = require('multer');

const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

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

    const prompt = `Transcribe the audio provided. Identify the speakers sequentially as 'Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4', or 'Speaker 5' based on their turns. If there are fewer than 5 speakers, only use the necessary number of speaker labels (e.g., if only two speakers, use 'Speaker 1' and 'Speaker 2').
Provide the full transcription first.
After the full transcription, start a new section with the heading "Summary:" followed by a concise summary of the discussion, including main topics and any agreed-upon actions or concerns.

Example Output Structure (for 2 speakers):
Speaker 1: Hello.
Speaker 2: Hi there.
Speaker 1: How are you?
Speaker 2: I'm good.
Summary:
This was a short greeting exchange.

Example Output Structure (for 3 speakers):
Speaker 1: Welcome everyone.
Speaker 2: Glad to be here.
Speaker 3: Thanks for having us.
Speaker 1: Let's begin.
Summary:
The meeting started with greetings.
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
        const text = result.candidates[0].content.parts[0].text;

        const lines = text.split('\n');
        let transcriptionLines = [];
        let summaryLines = [];
        let foundSummary = false;

        const summaryKeywords = [
          "Summary:", 
          "SUMMARY:", 
          "Key Points:", 
          "KEY POINTS:", 
          "## Summary", 
          "## Key Points"
        ];

        for (const line of lines) {
          if (!foundSummary) {
            let isSummaryKeywordLine = false;
            for (const keyword of summaryKeywords) {
              if (line.trim().startsWith(keyword)) {
                isSummaryKeywordLine = true;
                foundSummary = true;
                const summaryStartText = line.trim().substring(keyword.length).trim();
                if (summaryStartText) {
                  summaryLines.push(summaryStartText);
                }
                break; 
              }
            }
            if (!isSummaryKeywordLine && !foundSummary) {
              transcriptionLines.push(line);
            }
          } else {
            summaryLines.push(line);
          }
        }

        const transcriptionText = transcriptionLines.join('\n').trim();
        const summaryText = summaryLines.join('\n').trim();

        if (!foundSummary && transcriptionText) {
          return res.json({
            transcription: transcriptionText,
            summary: "Summary not explicitly found in the output."
          });
        } else {
          return res.json({
            transcription: transcriptionText,
            summary: summaryText
          });
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