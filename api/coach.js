// In-memory rate limiting (resets when serverless function cold starts, which is fine)
const globalCounter = { count: 0, resetDate: '' };
const userLimits = new Map();

// === CONFIGURATION (override via Vercel env vars) ===
const DAILY_GLOBAL_BUDGET = parseInt(process.env.DAILY_API_BUDGET) || 2000;
const USER_HOURLY_LIMIT = parseInt(process.env.USER_HOURLY_LIMIT) || 10;
const KILL_SWITCH = process.env.API_KILL_SWITCH === 'true';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // === KILL SWITCH ===
  if (KILL_SWITCH) {
    return res.status(503).json({ error: 'AI features are temporarily paused. Try again later! 🔧' });
  }

  const { prompt, mode, userId } = req.body;
  if (!prompt || !mode) return res.status(400).json({ error: 'Missing prompt or mode' });

  // === GLOBAL DAILY BUDGET ===
  const today = new Date().toISOString().split('T')[0];
  if (globalCounter.resetDate !== today) {
    globalCounter.count = 0;
    globalCounter.resetDate = today;
  }
  if (globalCounter.count >= DAILY_GLOBAL_BUDGET) {
    return res.status(429).json({ error: 'LearnBot is resting — too many students today! Try again tomorrow. 📚' });
  }

  // === PER-USER HOURLY LIMIT ===
  const userKey = userId || req.headers['x-forwarded-for'] || 'anon';
  const now = Date.now();
  if (!userLimits.has(userKey)) userLimits.set(userKey, []);
  const userHistory = userLimits.get(userKey).filter(t => t > now - 3600000);
  userLimits.set(userKey, userHistory);
  if (userHistory.length >= USER_HOURLY_LIMIT) {
    return res.status(429).json({ error: 'Slow down! Take a break and try again in a bit. ⏳' });
  }
  userHistory.push(now);
  globalCounter.count++;

  // === TRUNCATE INPUT ===
  const safePrompt = prompt.substring(0, 2000);

  const prompts = {
    quiz: `You are a study coach. Based on the following notes/topic, generate a quiz with exactly 5 multiple-choice questions. Each question should have 4 options (A-D) with one correct answer. Format your response as JSON only, no markdown, no backticks: {"questions":[{"q":"question text","options":["A) ...","B) ...","C) ...","D) ..."],"correct":0,"explanation":"brief explanation"}]}. Notes/Topic: ${safePrompt}`,
    flashcards: `You are a study coach. Based on the following notes/topic, generate exactly 8 flashcards that cover the key concepts. Format your response as JSON only, no markdown, no backticks: {"cards":[{"front":"term or question","back":"definition or answer"}]}. Notes/Topic: ${safePrompt}`,
    summary: `You are a study coach. Based on the following notes/topic, create a concise study summary with key takeaways. Format your response as JSON only, no markdown, no backticks: {"title":"topic title","sections":[{"heading":"section heading","points":["key point 1","key point 2"]}],"keyTerms":[{"term":"term","definition":"definition"}]}. Notes/Topic: ${safePrompt}`,
    explain: `You are a study coach. The student is confused about the following topic. Explain it simply using an analogy, then give a concrete example. Format your response as JSON only, no markdown, no backticks: {"topic":"topic name","simpleExplanation":"explanation in simple terms","analogy":"real-world analogy","example":"concrete example","commonMistakes":["mistake 1","mistake 2"]}. Notes/Topic: ${safePrompt}`
  };

  const systemPrompt = prompts[mode];
  if (!systemPrompt) return res.status(400).json({ error: 'Invalid mode' });

  const maxTokens = (mode === 'quiz' || mode === 'flashcards') ? 1500 : 800;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: systemPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic error:', response.status, errText);
      if (response.status === 429) return res.status(429).json({ error: 'AI is busy, try again in a moment.' });
      return res.status(500).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const text = data.content?.map(i => i.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();

    // Log for monitoring
    const inTok = data.usage?.input_tokens || 0;
    const outTok = data.usage?.output_tokens || 0;
    const cost = (inTok * 3 + outTok * 15) / 1000000;
    console.log(`[AI] ${mode} user=${userKey.substring(0,8)} cost=$${cost.toFixed(4)} daily=${globalCounter.count}/${DAILY_GLOBAL_BUDGET}`);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('Parse error:', clean.substring(0, 200));
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    return res.status(200).json({ result: parsed });
  } catch (err) {
    console.error('Coach error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
