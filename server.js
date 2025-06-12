const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

const app = express();
const upload = multer({ dest: 'uploads/' });

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname;
  let audioData, base64Audio, mimeType;

  try {
    audioData = await fs.readFile(filePath);
    base64Audio = audioData.toString('base64');

    if (originalName.endsWith('.mp3')) {
      mimeType = 'audio/mpeg';
    } else if (originalName.endsWith('.wav')) {
      mimeType = 'audio/wav';
    } else if (originalName.endsWith('.flac')) {
      mimeType = 'audio/flac';
    } else {
      await fs.unlink(filePath);
      return res.status(400).json({ error: "Unsupported audio file type. Please use .mp3, .wav, or .flac." });
    }
  } catch (error) {
    await fs.unlink(filePath);
    return res.status(500).json({ error: `Error reading audio file: ${error.message}` });
  }

  const prompt = `Transcribe the audio provided. Identify the speakers as 'Person A' and 'Person B' based on their turns.
  After transcribing, summarize the key points and any decisions made in the discussion.

  Output format:
  - Full transcription with speaker identification for each line.
  - A concise summary of the discussion, including main topics and any agreed-upon actions or concerns.
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

    await fs.unlink(filePath);

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

      // Keywords to identify the start of the summary section
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
        // If no summary keyword found, but there is text, assume all is transcription
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
    await fs.unlink(filePath);
    return res.status(500).json({ error: `Error calling Gemini API: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RESTful API server listening on port ${PORT}`);
});

/*
To run this script:
1. Save the code as 'index.js'.
2. Make sure you have Node.js installed on your system.
3. IMPORTANT: This script exposes a RESTful API. You can send a POST request
   to the '/transcribe' endpoint with an audio file to transcribe it.
4. Replace 'YOUR_GEMINI_API_KEY' with your actual Gemini API key.
5. If you are using Node.js versions older than 18, you might need to install 'node-fetch':
   npm install node-fetch
6. Run the script from your terminal:
   node index.js

Remember that there's a file size limit (typically 20MB) for sending audio
as inline data. For larger audio files, you would typically upload them
to a cloud storage service (like Google Cloud Storage) and provide the
`fileUri` in the Gemini API request, or use a dedicated ASR service.
*/
